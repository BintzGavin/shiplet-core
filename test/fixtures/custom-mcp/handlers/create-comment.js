export async function handle(input, context) {
  const result = await context.requestCapability({
    capability: "review.feedback.write",
    resource: `feedback:${input.threadId}`,
    input,
  });
  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}
