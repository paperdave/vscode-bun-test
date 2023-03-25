/* eslint-disable @typescript-eslint/naming-convention */
import { Node, parse } from "acorn";
import { TextDecoder } from "util";
import * as vscode from "vscode";
import * as walk from "acorn-walk";
import { generate } from "escodegen";
import * as path from "path";
import { spawn } from "child_process";
import { rm, writeFile } from "fs/promises";
import { performance } from "perf_hooks";
import stripAnsi = require("strip-ansi");

function labelNodeToString(node: any) {
  return node.type === "Literal" ? node.value : generate(node);
}

const textDecoder = new TextDecoder("utf-8");

export type BunTestData = TestFile | TestCase;

export const testData = new WeakMap<vscode.TestItem, BunTestData>();

function offsetsToRange(
  text: string,
  offset1: number,
  offset2: number
): vscode.Range {
  const lines = text.split("\n");
  let startLineNum = 0;
  let endLineNum = 0;
  let startCharNum = offset1;
  let endCharNum = offset2;

  while (
    startCharNum >= lines[startLineNum].length &&
    startLineNum < lines.length - 1
  ) {
    startCharNum -= lines[startLineNum].length + 1;
    startLineNum++;
  }

  while (
    endCharNum >= lines[endLineNum].length &&
    endLineNum < lines.length - 1
  ) {
    endCharNum -= lines[endLineNum].length + 1;
    endLineNum++;
  }

  if (
    startLineNum > endLineNum ||
    (startLineNum === endLineNum && startCharNum > endCharNum)
  ) {
    throw new Error();
  }

  const startPosition = new vscode.Position(startLineNum, 0);
  const endPosition = new vscode.Position(endLineNum, 0);

  return new vscode.Range(startPosition, endPosition);
}

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
    const editedContent = content
      .replace(
        /from\s*"bun:test"/g,
        'from "vscode-bun-test:' + (item.uri?.fsPath ?? item.uri?.path) + '"'
      )
      .replace(
        /from\s*'bun:test'/g,
        "from 'vscode-bun-test:" + (item.uri?.fsPath ?? item.uri?.path) + "'"
      );
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
            .map((x) => [labelNodeToString(x.arguments[0]), x]);

          if (node.callee.name !== vars.describe) {
            describeList.push([name, node]);
          }

          let parent = item;
          for (let i = 0; i < describeList.length; i++) {
            const id = describeList.slice(0, i + 1).join(" / ");
            let test = describes[id];
            if (!test) {
              test = controller.createTestItem(
                id,
                describeList[i][0],
                item.uri
              );
              test.range = offsetsToRange(
                content,
                describeList[i][1].start,
                describeList[i][1].end
              );
              parent.children.add(test);
              describes[id] = test;
              testData.set(
                test,
                new TestCase(
                  item.uri!.fsPath,
                  describeList.slice(0, i + 1).map((x) => x[0]),
                  editedContent
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

interface ErrorMetadata {
  type: string;
  message: string;
  line: number;
  col: number;
}

function escapeRegExp(string: string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $& means the whole matched string
}

function parseErrors(outputLog: string, file: string): ErrorMetadata[] {
  const errors: ErrorMetadata[] = [];

  const regex = new RegExp(
    `(?:^\\s*\\^\\s*$\\n)?(\\w+): (.*)\\n(?:^\\s*\\^\\s*$\\n)?\\s*at ${escapeRegExp(
      file
    )}:(\\d+):(\\d+)`,
    "gm"
  );
  const matches = outputLog.matchAll(regex);

  for (const match of matches) {
    const [, errorType, message, line, col] = match;
    errors.push({
      type: errorType,
      message,
      line: parseInt(line),
      col: parseInt(col),
    });
  }

  return errors;
}
export class TestCase {
  constructor(
    public file: string,
    public path: string[],
    public fileContent: string
  ) {}

  getLabel() {
    return `fasdsdfa`;
  }

  async run(test: vscode.TestItem, run: vscode.TestRun) {
    return new Promise<void>(async (done, err) => {
      const dir = path.dirname(this.file);
      const tempFile = path.join(dir, `${Date.now()}_temp_bun_vscode.ts`);
      await writeFile(tempFile, this.fileContent);
      const proc = spawn(
        "bun",
        ["test", "/code/paperdave/vscode-bun-test/runner.test.js"],
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
          cwd: "/code/paperdave/vscode-bun-test",
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

            currentLog = currentLog
              .replace(/"vscode-bun-test:.*?"/g, '"bun:test"')
              .replace(/'vscode-bun-test:.*?'/g, "'bun:test'")
              .replace(tempFile, test.uri!.fsPath);

            run.appendOutput(currentLog, undefined, t);

            const state = line[9] === "✓" ? "passed" : "failed";
            if (state === "passed") {
              run.passed(t, time);
            } else {
              run.failed(
                t,
                parseErrors(stripAnsi(currentLog), test.uri!.fsPath).map(
                  (x) => {
                    return {
                      message: `${x.type}: ${x.message}`,
                      location: new vscode.Location(
                        test.uri!,
                        new vscode.Position(x.line - 1, x.col)
                      ),
                    };
                  }
                ),
                time
              );
            }
            currentLog = "";
          } else {
            currentLog += line + "\n";
          }
        }
      });
      proc.on("exit", (status) => {
        rm(tempFile);
        run.end();
        done();
      });
    });
  }
}
