const SIZE_WARN_BYTES = 28000;

export function parseAndTrimCard(contentJson: string): object {
  const card = JSON.parse(contentJson) as Record<string, unknown>;
  const size = Buffer.byteLength(JSON.stringify(card));

  if (size <= SIZE_WARN_BYTES) return card;

  console.warn(
    `[Dispatcher] Card size ${size} bytes exceeds ${SIZE_WARN_BYTES} — truncating routine PR details`
  );

  // Remove routine PR details from elements that carry them
  if (Array.isArray(card.elements)) {
    card.elements = (card.elements as unknown[]).filter((el) => {
      const e = el as Record<string, unknown>;
      // Drop accordion/detail blocks tagged as routine
      return !(e.tag === "collapsible_panel" && e["data-significance"] === "routine");
    });
  }

  return card;
}
