const { tests, files } = JSON.parse(process.env.BUN_VSCODE_TEST_DATA);
Bun.plugin({
  name: "bun-test-interception",
  setup(builder) {
    builder.onResolve(
      { filter: /./, namespace: "vscode-bun-test" },
      ({ path }) => {
        return { path, namespace: "vscode-bun-test" };
      }
    );
    builder.onLoad(
      { filter: /./, namespace: "vscode-bun-test" },
      ({ path }) => {
        const jest = Bun.jest(path);

        let stack = [];

        function describe(name, cb) {
          let filtered = tests.filter((x) => x.length > stack.length);
          if (
            filtered.length === 0 ||
            filtered.some((x) => x[stack.length] === name)
          ) {
            stack.push(name);
            jest.describe(name, cb);
            stack.pop();
          }
        }

        function test(name, cb) {
          let filtered = tests.filter((x) => x.length > stack.length);
          if (
            filtered.length === 0 ||
            filtered.some((x) => x[stack.length] === name)
          ) {
            jest.test(name, cb);
          }
        }

        describe.describe = describe;
        describe.test = test;
        describe.it = test;
        test.skip = () => {};
        test.only = test;

        describe.expect = jest.expect;
        describe.afterAll = jest.afterAll;
        describe.afterEach = jest.afterEach;
        describe.beforeAll = jest.beforeAll;
        describe.beforeEach = jest.beforeEach;

        return {
          exports: describe,
          loader: "object",
        };
      }
    );
  },
});

for (const file of files) {
  await import(file);
}
