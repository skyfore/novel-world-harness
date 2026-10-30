/** Discovery and complete reads are separate modes. A valid source query must
 * never be mislabeled as an offset error or rejected as artifact-only search. */
export function assertConsumerReadMode(a: { collection: string; query?: string; refs?: string[]; segmentIds?: string[]; offset: number }) {
  if (a.query && (a.collection === "consumer" || a.refs || a.segmentIds))
    throw new Error("CONSUMER_READ_MODE Discover with read_consumer_revalidation collection=source or artifacts, query and offset=0; copy items[].id into segmentIds or items[].ref into refs for a separate full read without query. Correct once; no unchanged retry.");
  if ((a.segmentIds && a.refs) || ((a.segmentIds || a.refs && a.collection !== "artifacts") && a.offset))
    throw new Error("CONSUMER_READ_MODE Choose discovery or one exact read mode; correct once using the same source/task discovery results, no guessed IDs.");
}
