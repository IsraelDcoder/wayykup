export const HUNT_ITEMS = [
  { name: 'Chair', image: '🪑' },
  { name: 'Pen', image: '🖊️' },
  { name: 'Soap', image: '🧼' },
  { name: 'Toothbrush', image: '🪥' },
  { name: 'Toothpaste', image: '🪥' },
  { name: 'Comb', image: '💇' },
  { name: 'Hairbrush', image: '🪮' },
  { name: 'Watch', image: '⌚' },
  { name: 'Glasses', image: '👓' },
  { name: 'Cup', image: '🥤' },
  { name: 'Book', image: '📖' },
  { name: 'Shoe', image: '👟' },
  { name: 'Slippers', image: '🩴' },
  { name: 'Pillow', image: '🛏️' },
  { name: 'Water bottle', image: '🧴' },
  { name: 'Table', image: '🪵' },
  { name: 'Keyboard', image: '⌨️' },
  { name: 'Laptop', image: '💻' },
  { name: 'Computer mouse', image: '🖱️' },
  { name: 'Smartphone', image: '📱' },
  { name: 'Headphones', image: '🎧' },
  { name: 'Backpack', image: '🎒' },
  { name: 'Plant', image: '🪴' },
  { name: 'Wallet', image: '👛' },
  { name: 'Keys', image: '🔑' },
  { name: 'Towel', image: '🧖' },
  { name: 'Spoon', image: '🥄' },
  { name: 'Plate', image: '🍽️' },
  { name: 'Television', image: '📺' },
  { name: 'Remote control', image: '🎛️' },
  { name: 'Tree', image: '🌳' },
  { name: 'Flower', image: '🌼' },
  { name: 'Leaf', image: '🍃' },
  { name: 'Coffee mug', image: '☕' },
  { name: 'Fan', image: '🪭' },
  { name: 'Mirror', image: '🪞' },
  { name: 'Bottle', image: '🍾' },
] as const;

export const OBJECTS_BY_DIFFICULTY = {
  easy: ['Toothbrush', 'Pillow', 'Chair', 'Bottle', 'Cup', 'Shoe', 'Keys', 'Comb', 'Towel', 'Mirror'],
  medium: ['Toothpaste', 'Fan', 'Laptop', 'Water bottle', 'Coffee mug', 'Remote control', 'Book', 'Spoon', 'Plate', 'Watch'],
  hard: HUNT_ITEMS.map((item) => item.name),
} as const;

export function huntTargetsForDifficulty(difficulty: keyof typeof OBJECTS_BY_DIFFICULTY): string[] {
  const supported = new Set(HUNT_ITEMS.map((item) => item.name));
  return OBJECTS_BY_DIFFICULTY[difficulty]
    .filter((name) => supported.has(name));
}

export function chooseHuntTargetForDifficulty(
  difficulty: keyof typeof OBJECTS_BY_DIFFICULTY,
  random = Math.random,
  previousTarget?: string,
): string | null {
  return chooseHuntTarget(huntTargetsForDifficulty(difficulty), random, previousTarget);
}

export function chooseHuntTarget(
  targets: string[],
  random = Math.random,
  previousTarget?: string,
): string | null {
  const validTargets = targets.filter((target) => HUNT_ITEMS.some((item) => item.name === target));
  const alternatives = previousTarget && validTargets.length > 1
    ? validTargets.filter((target) => target !== previousTarget)
    : validTargets;
  if (!alternatives.length) return null;
  return alternatives[Math.floor(random() * alternatives.length)] ?? alternatives[0];
}

const OBJECT_LABELS: Record<string, readonly string[]> = {
  Chair: ['chair', 'armchair', 'seat', 'stool'],
  Pen: ['pen', 'ballpoint pen', 'fountain pen', 'writing implement'],
  Soap: ['soap', 'bar soap', 'liquid soap'],
  Toothbrush: ['toothbrush', 'electric toothbrush'],
  Toothpaste: ['toothpaste', 'toothpaste tube'],
  Comb: ['comb'],
  Hairbrush: ['hairbrush', 'hair brush'],
  Watch: ['watch', 'wristwatch', 'digital watch'],
  Glasses: ['glasses', 'eyeglasses', 'sunglasses'],
  Cup: ['cup', 'drinking glass', 'tumbler'],
  Book: ['book', 'textbook', 'comic book'],
  Shoe: ['shoe', 'footwear', 'sneaker', 'running shoe', 'boot'],
  Slippers: ['slipper', 'slippers', 'flip flop'],
  Pillow: ['pillow', 'cushion'],
  'Water bottle': ['water bottle', 'flask'],
  Table: ['table', 'desk', 'furniture'],
  Keyboard: ['keyboard', 'computer keyboard'],
  Laptop: ['laptop', 'notebook computer'],
  'Computer mouse': ['computer mouse'],
  Smartphone: ['smartphone', 'mobile phone', 'cellular telephone', 'phone'],
  Headphones: ['headphones', 'headset', 'earphones', 'earbuds'],
  Backpack: ['backpack', 'rucksack'],
  Plant: ['plant', 'houseplant', 'potted plant'],
  Wallet: ['wallet', 'purse'],
  Keys: ['key', 'keys'],
  Towel: ['towel', 'bath towel'],
  Spoon: ['spoon', 'tablespoon'],
  Plate: ['plate', 'dish'],
  Television: ['television', 'tv', 'television receiver'],
  'Remote control': ['remote control', 'remote'],
  Tree: ['tree'],
  Flower: ['flower', 'blossom'],
  Leaf: ['leaf'],
  'Coffee mug': ['coffee mug', 'mug', 'coffee cup'],
  Fan: ['fan', 'electric fan', 'table fan', 'ceiling fan'],
  Mirror: ['mirror', 'looking glass'],
  Bottle: ['bottle', 'water bottle', 'plastic bottle', 'glass bottle'],
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
