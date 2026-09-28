// LiveAgent 移植：<crates/agent-ui/src/pages/skills-hub/skillStoreCache.ts>
// 注：lib/skills 未收录该模块（仅页面级缓存），按任务要求随页面一并移植。
import {
  buildClawHubSkillKey,
  type ClawHubSkillCard,
  type ClawHubSkillDetail,
  type ClawHubSort,
  getClawHubSkillDetail,
  listClawHubSkills,
  resolveClawHubSkillOwner,
  searchClawHubSkills,
} from "../../lib/skills/clawHub";

export const SKILL_STORE_CATALOG_STALE_MS = 2 * 60 * 1000;
export const SKILL_STORE_DETAIL_STALE_MS = 10 * 60 * 1000;

const MAX_CATALOG_CACHE_ENTRIES = 24;
const MAX_DETAIL_CACHE_ENTRIES = 80;

export type SkillStoreCatalogSnapshot = {
  items: ClawHubSkillCard[];
  cursor: string | null;
  updatedAt: number;
};

export type SkillStoreDetailSnapshot = {
  skill: ClawHubSkillCard;
  detail: ClawHubSkillDetail;
  updatedAt: number;
};

const catalogCache = new Map<string, SkillStoreCatalogSnapshot>();
const catalogRequests = new Map<string, Promise<SkillStoreCatalogSnapshot>>();
const detailCache = new Map<string, SkillStoreDetailSnapshot>();
const detailRequests = new Map<string, Promise<SkillStoreDetailSnapshot>>();

function writeLruEntry<T>(cache: Map<string, T>, key: string, value: T, limit: number) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > limit) {
    const oldestKey = cache.keys().next().value;
    if (typeof oldestKey !== "string") break;
    cache.delete(oldestKey);
  }
}

function readLruEntry<T>(cache: Map<string, T>, key: string) {
  const value = cache.get(key);
  if (!value) return null;
  cache.delete(key);
  cache.set(key, value);
  return value;
}

export function buildSkillStoreCatalogKey(query: string, sort: ClawHubSort) {
  const normalizedQuery = query.trim().replace(/\s+/g, " ").toLocaleLowerCase();
  return normalizedQuery ? `search:${normalizedQuery}` : `browse:${sort}`;
}

export function readSkillStoreCatalog(key: string) {
  return readLruEntry(catalogCache, key);
}

export function isSkillStoreCatalogFresh(snapshot: SkillStoreCatalogSnapshot, now = Date.now()) {
  return now - snapshot.updatedAt < SKILL_STORE_CATALOG_STALE_MS;
}

function areStoreCardsEqual(previous: ClawHubSkillCard, next: ClawHubSkillCard) {
  return (
    previous.slug === next.slug &&
    previous.displayName === next.displayName &&
    previous.summary === next.summary &&
    previous.latestVersion === next.latestVersion &&
    previous.downloads === next.downloads &&
    previous.stars === next.stars &&
    previous.installsCurrent === next.installsCurrent &&
    previous.updatedAt === next.updatedAt &&
    previous.ownerHandle === next.ownerHandle &&
    previous.webUrl === next.webUrl &&
    previous.downloadUrl === next.downloadUrl &&
    previous.topics.length === next.topics.length &&
    previous.topics.every((topic, index) => topic === next.topics[index])
  );
}

function reuseStoreCard(
  previousByKey: ReadonlyMap<string, ClawHubSkillCard>,
  next: ClawHubSkillCard,
) {
  const previous = previousByKey.get(buildClawHubSkillKey(next));
  return previous && areStoreCardsEqual(previous, next) ? previous : next;
}

export function dedupeSkillStoreItems(items: ClawHubSkillCard[]) {
  const seen = new Set<string>();
  return items.filter((item) => {
    const key = buildClawHubSkillKey(item);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function reconcileSkillStoreItems(
  previous: ClawHubSkillCard[],
  incoming: ClawHubSkillCard[],
) {
  const previousByKey = new Map(
    previous.map((item) => [buildClawHubSkillKey(item), item] as const),
  );
  return dedupeSkillStoreItems(incoming).map((item) => reuseStoreCard(previousByKey, item));
}

export function appendSkillStoreItems(previous: ClawHubSkillCard[], incoming: ClawHubSkillCard[]) {
  const previousByKey = new Map(
    previous.map((item) => [buildClawHubSkillKey(item), item] as const),
  );
  const next = [...previous];
  const indexes = new Map(
    previous.map((item, index) => [buildClawHubSkillKey(item), index] as const),
  );

  for (const item of dedupeSkillStoreItems(incoming)) {
    const key = buildClawHubSkillKey(item);
    const existingIndex = indexes.get(key);
    const reconciled = reuseStoreCard(previousByKey, item);
    if (existingIndex === undefined) {
      indexes.set(key, next.length);
      next.push(reconciled);
    } else {
      next[existingIndex] = reconciled;
    }
  }
  return next;
}

function reconcileFirstCatalogPage(
  cached: SkillStoreCatalogSnapshot | null,
  firstPage: ClawHubSkillCard[],
) {
  if (!cached || cached.items.length <= firstPage.length) {
    return reconcileSkillStoreItems(cached?.items ?? [], firstPage);
  }
  const refreshedFirstPage = reconcileSkillStoreItems(cached.items, firstPage);
  const refreshedKeys = new Set(refreshedFirstPage.map(buildClawHubSkillKey));
  return [
    ...refreshedFirstPage,
    ...cached.items.filter((item) => !refreshedKeys.has(buildClawHubSkillKey(item))),
  ];
}

export async function loadSkillStoreCatalog(params: {
  query: string;
  sort: ClawHubSort;
  limit: number;
}) {
  const query = params.query.trim();
  const key = buildSkillStoreCatalogKey(query, params.sort);
  const existingRequest = catalogRequests.get(key);
  if (existingRequest) return existingRequest;

  const cached = readSkillStoreCatalog(key);
  const request = (async (): Promise<SkillStoreCatalogSnapshot> => {
    if (query) {
      const results = await searchClawHubSkills({ query, limit: params.limit });
      return {
        items: reconcileSkillStoreItems(cached?.items ?? [], results),
        cursor: null,
        updatedAt: Date.now(),
      };
    }

    const results = await listClawHubSkills({ sort: params.sort, limit: params.limit });
    return {
      items: reconcileFirstCatalogPage(cached, results.items),
      cursor:
        cached && cached.items.length > results.items.length ? cached.cursor : results.nextCursor,
      updatedAt: Date.now(),
    };
  })().then((snapshot) => {
    writeLruEntry(catalogCache, key, snapshot, MAX_CATALOG_CACHE_ENTRIES);
    return snapshot;
  });

  catalogRequests.set(key, request);
  try {
    return await request;
  } finally {
    if (catalogRequests.get(key) === request) catalogRequests.delete(key);
  }
}

export async function loadMoreSkillStoreCatalog(params: {
  sort: ClawHubSort;
  cursor: string;
  limit: number;
}) {
  const key = buildSkillStoreCatalogKey("", params.sort);
  const requestKey = `${key}:cursor:${params.cursor}`;
  const existingRequest = catalogRequests.get(requestKey);
  if (existingRequest) return existingRequest;

  const request = listClawHubSkills({
    sort: params.sort,
    cursor: params.cursor,
    limit: params.limit,
  })
    .then((results): SkillStoreCatalogSnapshot => {
      const cached = readSkillStoreCatalog(key);
      return {
        items: appendSkillStoreItems(cached?.items ?? [], results.items),
        cursor: results.nextCursor,
        updatedAt: Date.now(),
      };
    })
    .then((snapshot) => {
      writeLruEntry(catalogCache, key, snapshot, MAX_CATALOG_CACHE_ENTRIES);
      return snapshot;
    });

  catalogRequests.set(requestKey, request);
  try {
    return await request;
  } finally {
    if (catalogRequests.get(requestKey) === request) catalogRequests.delete(requestKey);
  }
}

export function readSkillStoreDetail(skill: ClawHubSkillCard) {
  return readLruEntry(detailCache, buildClawHubSkillKey(skill));
}

export function isSkillStoreDetailFresh(
  snapshot: SkillStoreDetailSnapshot,
  skill: ClawHubSkillCard,
  now = Date.now(),
) {
  const versionMatches =
    !skill.latestVersion || snapshot.detail.latestVersion === skill.latestVersion;
  const updateMatches = !skill.updatedAt || snapshot.detail.updatedAt === skill.updatedAt;
  return versionMatches && updateMatches && now - snapshot.updatedAt < SKILL_STORE_DETAIL_STALE_MS;
}

export async function loadSkillStoreDetail(skill: ClawHubSkillCard) {
  const initialKey = buildClawHubSkillKey(skill);
  const existingRequest = detailRequests.get(initialKey);
  if (existingRequest) return existingRequest;

  const request = resolveClawHubSkillOwner(skill)
    .then(async (resolvedSkill): Promise<SkillStoreDetailSnapshot> => {
      const detail = await getClawHubSkillDetail(resolvedSkill.slug, resolvedSkill.ownerHandle);
      return { skill: resolvedSkill, detail, updatedAt: Date.now() };
    })
    .then((snapshot) => {
      writeLruEntry(detailCache, initialKey, snapshot, MAX_DETAIL_CACHE_ENTRIES);
      writeLruEntry(
        detailCache,
        buildClawHubSkillKey(snapshot.skill),
        snapshot,
        MAX_DETAIL_CACHE_ENTRIES,
      );
      return snapshot;
    });

  detailRequests.set(initialKey, request);
  try {
    return await request;
  } finally {
    if (detailRequests.get(initialKey) === request) detailRequests.delete(initialKey);
  }
}
