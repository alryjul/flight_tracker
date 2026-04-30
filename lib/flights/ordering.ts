export function reconcileFlightOrder(currentOrder: string[], latestOrder: string[]) {
  const latestIds = new Set(latestOrder);
  const reconciled = currentOrder.filter((id) => latestIds.has(id));
  const seenIds = new Set(reconciled);

  for (const id of latestOrder) {
    if (!seenIds.has(id)) {
      reconciled.push(id);
      seenIds.add(id);
    }
  }

  return reconciled;
}

export function arraysMatch(left: string[], right: string[]) {
  return (
    left.length === right.length && left.every((value, index) => value === right[index])
  );
}

export function pinSelectedFlightOrder(
  currentOrder: string[],
  targetOrder: string[],
  selectedFlightId: string | null
) {
  if (!selectedFlightId) {
    return targetOrder;
  }

  const currentIndex = currentOrder.indexOf(selectedFlightId);
  const targetIndex = targetOrder.indexOf(selectedFlightId);

  if (currentIndex === -1 || targetIndex === -1) {
    return targetOrder;
  }

  const nextOrder = targetOrder.filter((id) => id !== selectedFlightId);
  nextOrder.splice(Math.min(currentIndex, nextOrder.length), 0, selectedFlightId);
  return nextOrder;
}

export function getRankChanges(previousOrder: string[], nextOrder: string[]) {
  const nextIndexById = new Map(nextOrder.map((id, index) => [id, index]));
  const changes: Record<string, number> = {};

  for (const [previousIndex, id] of previousOrder.entries()) {
    const nextIndex = nextIndexById.get(id);

    if (nextIndex == null || nextIndex === previousIndex) {
      continue;
    }

    changes[id] = previousIndex - nextIndex;
  }

  return changes;
}
