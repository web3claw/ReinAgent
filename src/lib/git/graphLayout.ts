/**
 * 提交图谱布局（P2 尾巴 #3，移植 ZCode packages/ui/src/git-graph 的
 * layoutAlgorithm.ts + layout.ts，裁掉 refs/选中态等 UI 附属）：
 * 依 parents 拓扑做泳道分配——线性历史单泳道，分支/合并分泳道着色。
 * 输出 SVG 坐标（行高/泳道间距可调），GitPanel 提交历史区直接渲染。
 */

/** 图谱输入：只需 hash + parents 拓扑（GitCommit 的子集）。 */
export interface GraphCommit {
  hash: string;
  parents: string[];
}

export interface GraphPoint {
  laneIndex: number;
  rowIndex: number;
}

export interface BranchLineSeed {
  from: GraphPoint;
  to: GraphPoint;
  laneIndex: number;
  sourceHash: string;
  targetHash: string;
  lockedFirst: boolean;
}

export interface GraphLayoutOptions {
  rowHeight?: number;
  laneGap?: number;
  lanePadding?: number;
  topPadding?: number;
  bottomPadding?: number;
}

export interface GraphLayoutRow {
  hash: string;
  rowIndex: number;
  laneIndex: number;
  x: number;
  y: number;
}

export interface GraphLayoutPath {
  id: string;
  laneIndex: number;
  path: string;
}

export interface GraphLayout {
  rows: GraphLayoutRow[];
  paths: GraphLayoutPath[];
  laneCount: number;
  width: number;
  height: number;
  rowHeight: number;
  laneGap: number;
}

const MISSING_PARENT_ID = -1;
const DEFAULT_ROW_HEIGHT = 42;
const DEFAULT_LANE_GAP = 14;
const DEFAULT_LANE_PADDING = 16;
const DEFAULT_TOP_PADDING = 20;
const DEFAULT_BOTTOM_PADDING = 18;

class LayoutBranch {
  readonly colourIndex: number;
  readonly lines: BranchLineSeed[] = [];
  endRowIndex = 0;

  constructor(colourIndex: number) {
    this.colourIndex = colourIndex;
  }

  addLine(from: GraphPoint, to: GraphPoint, sourceHash: string, targetHash: string, lockedFirst: boolean) {
    this.lines.push({ from, to, laneIndex: this.colourIndex, sourceHash, targetHash, lockedFirst });
  }
}

class LayoutVertex {
  readonly id: number;
  readonly hash: string;
  private readonly parents: LayoutVertex[] = [];
  private nextParentIndex = 0;
  private laneIndex: number | null = null;
  private branch: LayoutBranch | null = null;
  private nextLaneIndex = 0;
  private readonly connections: Array<LaneConnection | undefined> = [];

  constructor(id: number, hash: string) {
    this.id = id;
    this.hash = hash;
  }

  addParent(vertex: LayoutVertex) {
    this.parents.push(vertex);
  }

  getNextParent() {
    return this.nextParentIndex < this.parents.length ? this.parents[this.nextParentIndex]! : null;
  }

  registerParentProcessed() {
    this.nextParentIndex++;
  }

  isMerge() {
    return this.parents.length > 1;
  }

  isNotOnBranch() {
    return this.branch === null || this.laneIndex === null;
  }

  addToBranch(branch: LayoutBranch, laneIndex: number) {
    if (this.branch === null) {
      this.branch = branch;
      this.laneIndex = laneIndex;
    }
  }

  getBranch() {
    return this.branch;
  }

  getLaneIndex() {
    return this.laneIndex ?? 0;
  }

  getPoint(): GraphPoint {
    return { laneIndex: this.getLaneIndex(), rowIndex: this.id };
  }

  getNextPoint(): GraphPoint {
    return { laneIndex: this.nextLaneIndex, rowIndex: this.id };
  }

  getPointConnectingTo(target: LayoutVertex, branch: LayoutBranch) {
    const connectionIndex = this.connections.findIndex(
      (connection) => connection?.target === target && connection.branch === branch,
    );
    return connectionIndex >= 0 ? { laneIndex: connectionIndex, rowIndex: this.id } : null;
  }

  reservePoint(laneIndex: number, target: LayoutVertex, branch: LayoutBranch) {
    if (laneIndex === this.nextLaneIndex) {
      this.connections[laneIndex] = { target, branch };
      this.nextLaneIndex = laneIndex + 1;
    }
  }

  getWidthLaneIndex() {
    return this.nextLaneIndex;
  }
}

interface LaneConnection {
  target: LayoutVertex;
  branch: LayoutBranch;
}

function createVertices(commits: readonly GraphCommit[]) {
  const missingParent = new LayoutVertex(MISSING_PARENT_ID, "__missing_parent__");
  const vertices = commits.map((commit, index) => new LayoutVertex(index, commit.hash));
  const vertexByHash = new Map(vertices.map((vertex) => [vertex.hash, vertex]));

  for (const [index, commit] of commits.entries()) {
    const vertex = vertices[index]!;
    for (const parentHash of commit.parents) {
      const parent = vertexByHash.get(parentHash) ?? missingParent;
      vertex.addParent(parent);
    }
  }

  return { missingParent, vertices, vertexByHash };
}

function getAvailableColour(startAt: number, availableColours: number[]) {
  const reusableColour = availableColours.findIndex((endAt) => startAt > endAt);
  if (reusableColour >= 0) return reusableColour;
  availableColours.push(0);
  return availableColours.length - 1;
}

function determineMergePath(
  startAt: number,
  vertices: LayoutVertex[],
  vertex: LayoutVertex,
  parentVertex: LayoutVertex,
) {
  const parentBranch = parentVertex.getBranch()!;
  let lastPoint = vertex.getPoint();
  let foundConnectionToParent = false;

  for (let rowIndex = startAt + 1; rowIndex < vertices.length; rowIndex++) {
    const currentVertex = vertices[rowIndex]!;
    const existingPoint = currentVertex.getPointConnectingTo(parentVertex, parentBranch);
    const currentPoint = existingPoint ?? currentVertex.getNextPoint();
    foundConnectionToParent = existingPoint !== null;
    parentBranch.addLine(
      lastPoint,
      currentPoint,
      vertex.hash,
      parentVertex.hash,
      !foundConnectionToParent && currentVertex !== parentVertex
        ? lastPoint.laneIndex < currentPoint.laneIndex
        : true,
    );
    currentVertex.reservePoint(currentPoint.laneIndex, parentVertex, parentBranch);
    lastPoint = currentPoint;
    if (foundConnectionToParent) {
      vertex.registerParentProcessed();
      break;
    }
  }
}

function determineNormalPath(params: {
  startAt: number;
  vertices: LayoutVertex[];
  branches: LayoutBranch[];
  availableColours: number[];
  missingParent: LayoutVertex;
}) {
  const { startAt, vertices, branches, availableColours, missingParent } = params;
  let rowIndex = startAt;
  let vertex = vertices[rowIndex]!;
  let parentVertex = vertex.getNextParent();
  let lastPoint = vertex.isNotOnBranch() ? vertex.getNextPoint() : vertex.getPoint();
  const branch = new LayoutBranch(getAvailableColour(startAt, availableColours));
  vertex.addToBranch(branch, lastPoint.laneIndex);
  vertex.reservePoint(lastPoint.laneIndex, vertex, branch);

  for (rowIndex = startAt + 1; rowIndex < vertices.length; rowIndex++) {
    if (parentVertex === null || parentVertex === missingParent) break;
    const currentVertex = vertices[rowIndex]!;
    const currentPoint =
      parentVertex === currentVertex && !parentVertex.isNotOnBranch()
        ? currentVertex.getPoint()
        : currentVertex.getNextPoint();
    branch.addLine(
      lastPoint,
      currentPoint,
      vertex.hash,
      parentVertex.hash,
      lastPoint.laneIndex < currentPoint.laneIndex,
    );
    currentVertex.reservePoint(currentPoint.laneIndex, parentVertex, branch);
    lastPoint = currentPoint;
    if (parentVertex === currentVertex) {
      vertex.registerParentProcessed();
      const parentWasAlreadyOnBranch = !parentVertex.isNotOnBranch();
      parentVertex.addToBranch(branch, currentPoint.laneIndex);
      vertex = parentVertex;
      parentVertex = vertex.getNextParent();
      if (parentVertex === missingParent) {
        // 分页窗口外的 parent 没有可见节点，不能继续把线画到窗口底部。
        vertex.registerParentProcessed();
        break;
      }
      if (parentVertex === null || parentWasAlreadyOnBranch) break;
    }
  }

  branch.endRowIndex = rowIndex;
  branches.push(branch);
  availableColours[branch.colourIndex] = rowIndex;
}

function determinePath(params: {
  startAt: number;
  vertices: LayoutVertex[];
  branches: LayoutBranch[];
  availableColours: number[];
  missingParent: LayoutVertex;
}) {
  const vertex = params.vertices[params.startAt]!;
  const parentVertex = vertex.getNextParent();
  if (parentVertex === params.missingParent) {
    vertex.registerParentProcessed();
    return;
  }

  if (
    parentVertex !== null &&
    vertex.isMerge() &&
    !vertex.isNotOnBranch() &&
    !parentVertex.isNotOnBranch()
  ) {
    determineMergePath(params.startAt, params.vertices, vertex, parentVertex);
    return;
  }

  determineNormalPath(params);
}

function createGitGraphLayoutModel(commits: readonly GraphCommit[]) {
  const { missingParent, vertices, vertexByHash } = createVertices(commits);
  const branches: LayoutBranch[] = [];
  const availableColours: number[] = [];
  let index = 0;
  // 护栏：算法假定 git log 的最新在前顺序（parent 恒在更高下标）。若输入被
  // 颠倒/损坏，determineNormalPath 够不到 parent 时会原地打转——上限兜底防死循环。
  let iterations = 0;
  const maxIterations = vertices.length * 4 + 8;

  while (index < vertices.length) {
    if (++iterations > maxIterations) break;
    const vertex = vertices[index]!;
    if (vertex.getNextParent() !== null || vertex.isNotOnBranch()) {
      determinePath({ startAt: index, vertices, branches, availableColours, missingParent });
    } else {
      index++;
    }
  }

  return {
    vertices,
    vertexByHash,
    branchLines: branches.flatMap((branch) => branch.lines),
  };
}

interface PixelOptions {
  lanePadding: number;
  laneGap: number;
  topPadding: number;
  rowHeight: number;
}

function buildEdgePath(fromX: number, fromY: number, toX: number, toY: number, lockedFirst?: boolean): string {
  if (fromX === toX) {
    return `M ${fromX} ${fromY} L ${toX} ${toY}`;
  }

  const curveOffset = Math.max(14, Math.abs(toY - fromY) * 0.38);
  if (lockedFirst === false) {
    return ["M " + fromX + " " + fromY, "C " + fromX + " " + (toY - curveOffset) + ", " + toX + " " + (toY - curveOffset) + ", " + toX + " " + toY].join(" ");
  }

  return ["M " + fromX + " " + fromY, "C " + fromX + " " + (fromY + curveOffset) + ", " + toX + " " + (fromY + curveOffset) + ", " + toX + " " + toY].join(" ");
}

function pointToPixels(point: GraphPoint, options: PixelOptions) {
  return {
    x: options.lanePadding + point.laneIndex * options.laneGap,
    y: options.topPadding + point.rowIndex * options.rowHeight,
  };
}

/** 泳道着色（对齐 ZCode git-descendant/renamed/added/modified 四色轮转，见 global.css --git-lane-*）。 */
export const GIT_LANE_COLOUR_COUNT = 4;

export function layoutGitGraph(
  commits: readonly GraphCommit[],
  options: GraphLayoutOptions = {},
): GraphLayout {
  const rowHeight = options.rowHeight ?? DEFAULT_ROW_HEIGHT;
  const laneGap = options.laneGap ?? DEFAULT_LANE_GAP;
  const lanePadding = options.lanePadding ?? DEFAULT_LANE_PADDING;
  const topPadding = options.topPadding ?? DEFAULT_TOP_PADDING;
  const bottomPadding = options.bottomPadding ?? DEFAULT_BOTTOM_PADDING;
  const { vertices, branchLines } = createGitGraphLayoutModel(commits);

  const rows: GraphLayoutRow[] = vertices.map((vertex, rowIndex) => {
    const laneIndex = vertex.getLaneIndex();
    return {
      hash: commits[rowIndex]!.hash,
      rowIndex,
      laneIndex,
      x: lanePadding + laneIndex * laneGap,
      y: topPadding + rowIndex * rowHeight,
    };
  });
  const maxRowLaneIndex = rows.reduce((max, row) => Math.max(max, row.laneIndex), 0);
  const maxWidthLaneIndex = vertices.reduce(
    (max, vertex) => Math.max(max, vertex.getWidthLaneIndex() - 1),
    0,
  );
  const maxLineLaneIndex = branchLines.reduce(
    (max, line) => Math.max(max, line.from.laneIndex, line.to.laneIndex),
    0,
  );
  const laneCount = Math.max(1, maxRowLaneIndex + 1, maxWidthLaneIndex + 1, maxLineLaneIndex + 1);
  const height = topPadding + Math.max(0, commits.length - 1) * rowHeight + bottomPadding;
  const width = lanePadding * 2 + (laneCount - 1) * laneGap;
  const pixelOptions: PixelOptions = { lanePadding, laneGap, topPadding, rowHeight };
  const paths: GraphLayoutPath[] = branchLines.map((line, index) => {
    const from = pointToPixels(line.from, pixelOptions);
    const to = pointToPixels(line.to, pixelOptions);
    return {
      id: `${line.sourceHash}:${line.targetHash}:${line.from.rowIndex}:${line.to.rowIndex}:${index}:path`,
      laneIndex: line.laneIndex,
      path: buildEdgePath(from.x, from.y, to.x, to.y, line.lockedFirst),
    };
  });

  return { rows, paths, laneCount, width, height, rowHeight, laneGap };
}
