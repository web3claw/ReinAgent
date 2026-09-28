// LiveAgent 移植：<crates/agent-ui/src/pages/skills-hub/skillBulkSelection.ts>
export function toggleBulkSelection(selection: ReadonlySet<string>, name: string) {
  const next = new Set(selection);
  if (next.has(name)) next.delete(name);
  else next.add(name);
  return next;
}

export function updateBulkSelection(
  selection: ReadonlySet<string>,
  names: readonly string[],
  selected: boolean,
) {
  const next = new Set(selection);
  for (const name of names) {
    if (selected) next.add(name);
    else next.delete(name);
  }
  return next;
}

export function includesEveryBulkSelection(
  selection: ReadonlySet<string>,
  names: readonly string[],
) {
  return names.length > 0 && names.every((name) => selection.has(name));
}
