/* eslint-disable @typescript-eslint/naming-convention */
import { Node, parse } from "acorn";
import { TextDecoder } from "util";
import * as vscode from "vscode";
import * as walk from "acorn-walk";
import { generate } from "escodegen";
import path = require("path");
import { spawn, spawnSync } from "child_process";
import { writeFileSync } from "fs";
import { rm, writeFile } from "fs/promises";
import { performance } from "perf_hooks";

function labelNodeToString(node: any) {
  return node.type === "Literal" ? node.value : generate(node);
}

const textDecoder = new TextDecoder("utf-8");

export type BunTestData = TestFile | TestCase;

export const testData = new WeakMap<vscode.TestItem, BunTestData>();

export const getContentFromFilesystem = async (uri: vscode.Uri) => {
  try {
    const rawContent = await vscode.workspace.fs.readFile(uri);
    return textDecoder.decode(rawContent);
  } catch (e) {
    console.warn(`Error providing tests for ${uri.fsPath}`, e);
    return "";
  }
};

export class TestFile {
  public didResolve = false;
  public cachedParse: any = null;

  public async updateFromDisk(
    controller: vscode.TestController,
    item: vscode.TestItem
  ) {
    try {
      const content = await getContentFromFilesystem(item.uri!);
      item.error = undefined;
      this.updateFromContents(controller, content, item);
    } catch (e) {
      item.error = (e as Error).stack;
    }
  }

  /**
   * Parses the tests from the input text, and updates the tests contained
   * by this file to be those from the text,
   */
  public updateFromContents(
    controller: vscode.TestController,
    content: string,
    item: vscode.TestItem
  ) {
    const root = parse(content, {
      ecmaVersion: "latest",
      sourceType: "module",
    });
    let namespace = null;
    const vars: any = {
      describe: null,
      it: null,
      test: null,
    };
    const describes: Record<string, vscode.TestItem> = {};
    walk.ancestor(root, {
      ImportDeclaration(node: any) {
        if (!["bun:test", "jest", "vitest"].includes(node.source.value)) {
          return;
        }
        for (const specifier of node.specifiers) {
          if (
            specifier.type === "ImportSpecifier" &&
            specifier.imported.name in vars
          ) {
            vars[specifier.imported.name] = specifier.local.name;
          }
          if (specifier.type === "ImportNamespaceSpecifier") {
            namespace = specifier.local.name;
          }
        }
        node.source.value =
          "vscode-bun-test:" + (item.uri?.fsPath ?? item.uri?.path);
      },
      CallExpression(node: any, ancestors: any[]) {
        if (
          node.callee.type === "Identifier" &&
          [vars.it, vars.test, vars.describe].includes(node.callee.name)
        ) {
          const name = labelNodeToString(node.arguments[0]);

          const describeList = ancestors
            .filter(
              (ancestor) =>
                ancestor.type === "CallExpression" &&
                ancestor.callee.type === "Identifier" &&
                ancestor.callee.name === vars.describe
            )
            .map((x) => labelNodeToString(x.arguments[0]));

          if (node.callee.name !== vars.describe) {
            describeList.push(name);
          }

          let parent = item;
          for (let i = 0; i < describeList.length; i++) {
            const id = describeList.slice(0, i + 1).join(" / ");
            let test = describes[id];
            if (!test) {
              test = controller.createTestItem(id, describeList[i]);
              parent.children.add(test);
              describes[id] = test;
              testData.set(
                test,
                new TestCase(
                  item.uri!.fsPath,
                  describeList.slice(0, i + 1),
                  root
                )
              );
            }
            parent = test;
          }
        }
      },
    });
    this.cachedParse = root;
  }
}

export class TestCase {
  constructor(public file: string, public path: string[], public root: Node) {}

  getLabel() {
    return `fasdsdfa`;
  }

  async run(test: vscode.TestItem, run: vscode.TestRun) {
    return new Promise<void>(async (done, err) => {
      const dir = path.dirname(this.file);
      const tempFile = path.join(
        dir,
        `${Date.now()}_${path.basename(this.file)}`
      );
      await writeFile(tempFile, generate(this.root));
      console.log("owo", tempFile);
      const proc = spawn(
        "bun",
        ["test", "/code/paperdave/vscode-bun-test/src/runner.test.js"],
        {
          stdio: "pipe",
          env: {
            ...process.env,
            BUN_VSCODE_TEST_DATA: JSON.stringify({
              tests: [this.path],
              files: [tempFile],
            }),
            FORCE_COLOR: "1",
          },
          cwd: "/code/paperdave/vscode-bun-test/src/",
        }
      );
      let currentLog = "";
      let leftOver = "";
      let testStarted: number | null = null;
      proc.stdout.on("data", (chunk) => {
        currentLog += chunk;
      });
      proc.stderr.on("data", (chunk) => {
        const lines = (leftOver + chunk.toString("utf8")).split("\n");
        leftOver = lines.pop()!;
        for (const line of lines) {
          if (!testStarted) {
            if (line.trim() === "runner.test.js:") {
              testStarted = performance.now();
            }
            continue;
          }
          if (
            line.startsWith("\x1B[0m\x1B[32m✓\x1B[0m") ||
            line.startsWith("\x1B[0m\x1B[31m✗\x1B[0m")
          ) {
            const time = performance.now() - testStarted;
            testStarted = performance.now();
            const parts = line
              .slice(19, -4)
              .trim()
              .replace("\x1B[2m >\x1B[0m\x1B[1m ", "\x1B[2m > \x1B[0m")
              .split("\x1B[2m > \x1B[0m");

            function findChildTest(
              x: vscode.TestItemCollection,
              list: string[]
            ): vscode.TestItem {
              const find = [...x].find((x) => x[1].label === list[0]);
              if (!find) {
                return null!;
              }
              if (list.length !== 1) {
                return findChildTest(find[1].children, list.slice(1));
              }
              return find[1];
            }

            const sub = parts.slice(this.path.length);
            const t =
              sub.length === 0 ? test : findChildTest(test.children, sub);

            const state = line[9] === "✓" ? "passed" : "failed";
            console.log(parts, state, t);
            if (state === "passed") {
              run.passed(t, time);
            } else {
              run.failed(t, [], time);
            }
          } else {
            currentLog += line + "\n";
          }
        }
        console.log({ lines });
      });
      proc.on("exit", (status) => {
        rm(tempFile);
        if (status !== 0) {
          run.failed(test, [{ message: "status code " + status }]);
        }
        run.end();
        done();
      });
    });
  }
}
