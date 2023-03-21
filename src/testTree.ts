/* eslint-disable @typescript-eslint/naming-convention */
import { parse } from "acorn";
import { TextDecoder } from "util";
import * as vscode from "vscode";
import * as walk from "acorn-walk";
import { generate } from "escodegen";

function labelNodeToString(node: any) {
  return node.type === "Literal" ? node.value : generate(node);
}

const textDecoder = new TextDecoder("utf-8");

export type BunTestData = TestFile;

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
            }
            parent = test;
          }
        }
      },
    });
  }
}
