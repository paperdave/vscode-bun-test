import { debounce } from "@paperdave/utils";
import * as vscode from "vscode";
import { TestCase, testData, TestFile } from "./testTree";

export async function activate(context: vscode.ExtensionContext) {
  const ctrl = vscode.tests.createTestController("bunTestController", "Bun");
  context.subscriptions.push(ctrl);

  const fileChangedEmitter = new vscode.EventEmitter<vscode.Uri>();
  const runHandler = (
    request: vscode.TestRunRequest,
    cancellation: vscode.CancellationToken
  ) => {
    return startTestRun(request);
  };

  const startTestRun = (request: vscode.TestRunRequest) => {
    const queue: { test: vscode.TestItem; data: TestCase }[] = [];
    const run = ctrl.createTestRun(request);

    const discoverTests = async (tests: Iterable<vscode.TestItem>) => {
      for (const test of tests) {
        if (request.exclude?.includes(test)) {
          continue;
        }

        const data = testData.get(test);
        if (data instanceof TestCase) {
          run.enqueued(test);
          queue.push({ test, data });
        } else {
          if (data instanceof TestFile && !data.didResolve) {
            await data.updateFromDisk(ctrl, test);
          }

          await discoverTests(gatherTestItems(test.children));
        }
      }
    };

    const runTestQueue = async () => {
      for (const { test, data } of queue) {
        run.appendOutput(`Running ${test.id}\r\n`);
        if (run.token.isCancellationRequested) {
          run.skipped(test);
        } else {
          run.started(test);
          await data.run(test, run);
        }

        run.appendOutput(`Completed ${test.id}\r\n`);
      }

      run.end();
    };

    discoverTests(request.include ?? gatherTestItems(ctrl.items)).then(
      runTestQueue
    );
  };

  ctrl.refreshHandler = async () => {
    await Promise.all(
      getWorkspaceTestPatterns().map(({ pattern }) =>
        findInitialFiles(ctrl, pattern)
      )
    );
  };

  ctrl.createRunProfile(
    "Run Tests",
    vscode.TestRunProfileKind.Run,
    runHandler,
    true,
    undefined
  );

  ctrl.resolveHandler = async (item) => {
    if (!item) {
      context.subscriptions.push(
        ...startWatchingWorkspace(ctrl, fileChangedEmitter)
      );
      return;
    }

    const data = testData.get(item);
    if (data instanceof TestFile) {
      await data.updateFromDisk(ctrl, item);
    }
  };

  function updateNodeForDocument(e: vscode.TextDocument) {
    if (e.uri.scheme !== "file") {
      return;
    }

    if (!e.uri.path.match(/.*(?:_|\.)(?:test|spec)\.(?:js|ts|jsx|tsx)$/)) {
      return;
    }

    const { file, data } = getOrCreateFile(ctrl, e.uri);
    data.updateFromContents(ctrl, e.getText(), file);
  }

  for (const document of vscode.workspace.textDocuments) {
    updateNodeForDocument(document);
  }

  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument(updateNodeForDocument),
    vscode.workspace.onDidChangeTextDocument(
      debounce((e) => updateNodeForDocument(e.document), 250)
    )
  );
}

function getOrCreateFile(controller: vscode.TestController, uri: vscode.Uri) {
  const existing = controller.items.get(uri.toString());
  if (existing) {
    return { file: existing, data: testData.get(existing) as TestFile };
  }

  const file = controller.createTestItem(
    uri.toString(),
    uri.path.split("/").pop()!,
    uri
  );
  controller.items.add(file);

  const data = new TestFile();
  testData.set(file, data);

  file.canResolveChildren = true;
  return { file, data };
}

function gatherTestItems(collection: vscode.TestItemCollection) {
  const items: vscode.TestItem[] = [];
  collection.forEach((item) => items.push(item));
  return items;
}

function getWorkspaceTestPatterns() {
  if (!vscode.workspace.workspaceFolders) {
    return [];
  }

  return vscode.workspace.workspaceFolders.map((workspaceFolder) => ({
    workspaceFolder,
    pattern: new vscode.RelativePattern(
      workspaceFolder,
      "**/*{_,.}{test,spec}.{js,ts,jsx,tsx}"
    ),
  }));
}

async function findInitialFiles(
  controller: vscode.TestController,
  pattern: vscode.GlobPattern
) {
  for (const file of await vscode.workspace.findFiles(pattern)) {
    getOrCreateFile(controller, file);
  }
}

function startWatchingWorkspace(
  controller: vscode.TestController,
  fileChangedEmitter: vscode.EventEmitter<vscode.Uri>
) {
  return getWorkspaceTestPatterns().map(({ workspaceFolder, pattern }) => {
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);

    watcher.onDidCreate((uri) => {
      getOrCreateFile(controller, uri);
      fileChangedEmitter.fire(uri);
    });
    watcher.onDidChange(async (uri) => {
      const { file, data } = getOrCreateFile(controller, uri);
      if (data.didResolve) {
        await data.updateFromDisk(controller, file);
      }
      fileChangedEmitter.fire(uri);
    });
    watcher.onDidDelete((uri) => controller.items.delete(uri.toString()));

    findInitialFiles(controller, pattern);

    return watcher;
  });
}
