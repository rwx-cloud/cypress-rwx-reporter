// Top-level await, which `require` cannot load however async the hook itself is.
const kind = await Promise.resolve("failed");

export default function attachments() {
  return { screenshot: { html: `esm-${kind}` } };
}
