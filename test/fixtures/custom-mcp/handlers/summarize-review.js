export async function handle(input, context) {
  const feedback = await context.requestCapability({
    capability: "review.feedback.read",
    resource: `feedback:${input.threadId}`,
    input: { threadId: input.threadId },
  });
  return { content: [{ type: "text", text: JSON.stringify(feedback) }] };
}
