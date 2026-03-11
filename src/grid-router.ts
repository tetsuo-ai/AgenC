import type { Position, SolveResult } from './types';

function parseGrid(gridStr: string): string[][] {
  const lines = gridStr.trim().split(/\r?\n/);
  return lines.map(line => line.split(''));
}

function posToString(pos: Position): string {
  return `${pos.x},${pos.y}`;
}

function isWall(ch: string): boolean {
  return ch === '#';
}

function getCost(ch: string): number {
  if (ch === '.' || /[A-Z]/.test(ch)) return 1;
  if (/[0-9]/.test(ch)) return parseInt(ch, 10);
  return 1;
}

function findPortals(grid: string[][]): Map<string, Position[]> {
  const portals = new Map<string, Position[]>();
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      const ch = grid[y][x];
      if (/[A-Z]/.test(ch)) {
        if (!portals.has(ch)) portals.set(ch, []);
        portals.get(ch)!.push({ x, y });
      }
    }
  }
  return portals;
}

function getNeighbors(pos: Position, grid: string[][], portals: Map<string, Position[]>): {pos: Position; cost: number}[] {
  const dirs = [[0, 1], [1, 0], [0, -1], [-1, 0]];
  const neighbors: {pos: Position; cost: number}[] = [];
  const height = grid.length;
  const width = grid[0].length;
  const ch = grid[pos.y][pos.x];

  // Adjacent moves
  for (const [dx, dy] of dirs) {
    const nx = pos.x + dx;
    const ny = pos.y + dy;
    if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue;
    const nch = grid[ny][nx];
    if (isWall(nch)) continue;
    neighbors.push({ pos: { x: nx, y: ny }, cost: getCost(nch) });
  }

  // One-way/bidirectional portal jumps (same letter, cost 0)
  if (/[A-Z]/.test(ch)) {
    const others = portals.get(ch) || [];
    for (const other of others) {
      if (other.x !== pos.x || other.y !== pos.y) {
        neighbors.push({ pos: other, cost: 0 });
      }
    }
  }

  return neighbors;
}

export function solveBFS(gridStr: string, start: Position, end: Position): SolveResult {
  const grid = parseGrid(gridStr);
  const portals = findPortals(grid);
  const queue: Array<{pos: Position; path: Position[]; cost: number}> = [{ pos: start, path: [start], cost: 0 }];
  const visited = new Set<string>([posToString(start)]);
  let visitedCount = 1;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.pos.x === end.x && current.pos.y === end.y) {
      return {
        path: current.path,
        cost: current.cost,
        visited: visitedCount,
        length: current.path.length - 1
      };
    }

    for (const neigh of getNeighbors(current.pos, grid, portals)) {
      const nkey = posToString(neigh.pos);
      if (!visited.has(nkey)) {
        visited.add(nkey);
        visitedCount++;
        const newCost = current.cost + 1; // BFS treats moves as uniform cost 1
        queue.push({
          pos: neigh.pos,
          path: [...current.path, neigh.pos],
          cost: newCost
        });
      }
    }
  }

  return { path: [], cost: 0, visited: visitedCount, length: 0 };
}

function solveWithPriorityQueue(gridStr: string, start: Position, end: Position, useAStar = false): SolveResult {
  const grid = parseGrid(gridStr);
  const portals = findPortals(grid);
  const pq: Array<{pos: Position; cost: number; path?: Position[]}> = [];
  const dist = new Map<string, number>();
  const cameFrom = new Map<string, Position>();
  const startKey = posToString(start);
  dist.set(startKey, 0);
  pq.push({ pos: start, cost: 0 });

  const visitedSet = new Set<string>();
  let visitedCount = 0;

  while (pq.length > 0) {
    pq.sort((a, b) => a.cost - b.cost);
    const current = pq.shift()!;
    const ckey = posToString(current.pos);

    if (visitedSet.has(ckey)) continue;
    visitedSet.add(ckey);
    visitedCount++;

    if (current.pos.x === end.x && current.pos.y === end.y) {
      // Reconstruct path
      const path: Position[] = [];
      let cur: Position | undefined = current.pos;
      while (cur) {
        path.unshift(cur);
        cur = cameFrom.get(posToString(cur));
      }
      return { path, cost: dist.get(ckey) || current.cost, visited: visitedCount, length: path.length - 1 };
    }

    for (const neigh of getNeighbors(current.pos, grid, portals)) {
      const npos = neigh.pos;
      const nkey = posToString(npos);
      const tentative = (dist.get(ckey) || current.cost) + neigh.cost;
      let priority = tentative;

      if (useAStar) {
        const h = Math.abs(npos.x - end.x) + Math.abs(npos.y - end.y); // Manhattan heuristic
        priority += h;
      }

      if (!dist.has(nkey) || tentative < (dist.get(nkey) || Infinity)) {
        dist.set(nkey, tentative);
        cameFrom.set(nkey, current.pos);
        pq.push({ pos: npos, cost: priority });
      }
    }
  }

  return { path: [], cost: Infinity, visited: visitedCount, length: 0 };
}

export function solveDijkstra(gridStr: string, start: Position, end: Position): SolveResult {
  return solveWithPriorityQueue(gridStr, start, end, false);
}

export function solveAStar(gridStr: string, start: Position, end: Position): SolveResult {
  return solveWithPriorityQueue(gridStr, start, end, true);
}
