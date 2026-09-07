import path from "node:path";
/** Node's parent test runner supplies typed events; test stdout is diagnostic data. */
export default async function* reporter(events: AsyncIterable<{ type: string; data: any }>) {
  let tests = 0;
  for await (const event of events) {
    if (event.type === "test:pass" && event.data.details?.type === "test" && typeof event.data.file === "string" &&
        path.resolve(event.data.name) !== path.resolve(event.data.file)) tests++;
    if (event.type === "test:summary" && !event.data.file) {
      yield JSON.stringify({ tests, passed: tests,
        failed: event.data.counts?.failed, cancelled: event.data.counts?.cancelled,
        skipped: event.data.counts?.skipped, todo: event.data.counts?.todo }) + "\n";
    }
  }
}
