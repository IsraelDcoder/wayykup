export const HUNT_ITEMS = [
  { name: 'Chair', image: '🪑' },
  { name: 'Pen', image: '🖊️' },
  { name: 'Soap', image: '🧼' },
  { name: 'Toothbrush', image: '🪥' },
  { name: 'Cup', image: '🥤' },
  { name: 'Book', image: '📖' },
  { name: 'Shoe', image: '👟' },
  { name: 'Pillow', image: '🛏️' },
  { name: 'Water bottle', image: '🧴' },
  { name: 'Table', image: '🪵' },
  { name: 'Keyboard', image: '⌨️' },
  { name: 'Headphones', image: '🎧' },
  { name: 'Backpack', image: '🎒' },
  { name: 'Plant', image: '🪴' },
  { name: 'Wallet', image: '👛' },
  { name: 'Coffee mug', image: '☕' },
] as const;

export function chooseHuntTarget(targets: string[], random = Math.random): string | null {
  const validTargets = targets.filter((target) => HUNT_ITEMS.some((item) => item.name === target));
  if (!validTargets.length) return null;
  return validTargets[Math.floor(random() * validTargets.length)] ?? validTargets[0];
}

const OBJECT_LABELS: Record<string, readonly string[]> = {
  Chair: ['chair', 'armchair', 'seat', 'stool'],
  Pen: ['pen', 'ballpoint pen', 'fountain pen', 'writing implement'],
  Soap: ['soap', 'bar soap', 'liquid soap'],
  Toothbrush: ['toothbrush', 'electric toothbrush'],
  Cup: ['cup', 'drinking glass', 'tumbler'],
  Book: ['book', 'textbook', 'comic book'],
  Shoe: ['shoe', 'footwear', 'sneaker', 'running shoe', 'boot'],
  Pillow: ['pillow', 'cushion'],
  'Water bottle': ['water bottle', 'bottle', 'flask'],
  Table: ['table', 'desk', 'furniture'],
  Keyboard: ['keyboard', 'computer keyboard'],
  Headphones: ['headphones', 'headset', 'earphones', 'earbuds'],
  Backpack: ['backpack', 'rucksack'],
  Plant: ['plant', 'houseplant', 'potted plant'],
  Wallet: ['wallet', 'purse'],
  'Coffee mug': ['coffee mug', 'mug', 'coffee cup'],
};

const MIN_OBJECT_LABEL_CONFIDENCE = 0.25;

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

export function matchesHuntObject(
  target: string,
  predictions: { label: string; confidence: number }[],
): boolean {
  const expectedLabels = OBJECT_LABELS[target];
  if (!expectedLabels) return false;
  const normalizedExpectedLabels = new Set(expectedLabels.map(normalizeLabel));

  return predictions.some(({ label, confidence }) =>
    Number.isFinite(confidence)
    && confidence >= MIN_OBJECT_LABEL_CONFIDENCE
    && normalizedExpectedLabels.has(normalizeLabel(label)),
  );
}
