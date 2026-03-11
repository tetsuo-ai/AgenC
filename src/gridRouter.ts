import * as fs from 'fs';

export interface Position {
  x: number;
  y: number;
}

export interface Tile {
  x: number;
  y: number;
  type: string;
  weight: number;
  isWalkable: boolean;
}

export interface Grid {
  width: number;
  height: number;
  tiles: Tile[][];
  portals: Map<string, Position[]>;
}

export interface PathResult {
  path: Position[];
  cost: number;
  visited: number;
  algorithm: string;
}

export type Algorithm = 'bfs' | 'dijkstra' | 'astar';

function parseGrid(map: string): Grid {
  const lines = map.trim().split('\n');
  const height = lines.length;
  const width = lines[0].length;
  const tiles: Tile[][] = [];
  const portals = new Map<string, Position[]>();

  for (let y = 0; y < height; y++) {
    tiles[y] = [];
    for (let x = 0; x < width; x++) {
      const char = lines[y][x];
      let weight = 1;
      let isWalkable = char !== '#';
      let type = char;

      if (!isNaN(parseInt(char)) && char !== '0') {
        weight = parseInt(char);
        type = '.';
      } else if (char === '.') {
        weight = 1;
      } else if (/[A-Z]/.test(char)) {
        // Uppercase for one-way portal entrance
        if (!portals.has(char)) portals.set(char, []);
        portals.get(char)!.push({x, y});
        weight = 1;
        isWalkable = true;
        type = char;
      } else if (/[a-z]/.test(char)) {
        // Lowercase for exit
        const upper = char.toUpperCase();
        if (!portals.has(upper)) portals.set(upper, []);
        portals.get(upper)!.push({x, y});
        weight = 1;
        isWalkable = true;
        type = char;
      }

      tiles[y][x] = { x, y, type, weight, isWalkable };
    }
  }

  return { width, height, tiles, portals };
}

function getNeighbors(grid: Grid, pos: Position, algorithm: Algorithm): Position[] {
  const dirs = [[0,1],[1,0],[0,-1],[-1,0]];
  const neighbors: Position[] = [];

  for (const [dx, dy] of dirs) {
    const nx = pos.x + dx;
    const ny = pos.y + dy;
    if (nx >= 0 && nx < grid.width && ny >= 0 && ny < grid.height) {
      const tile = grid.tiles[ny][nx];
      if (tile.isWalkable) {
        neighbors.push({x: nx, y: ny});
      }
    }
  }

  // Handle portals - one way from upper to lower
  const tile = grid.tiles[pos.y][pos.x];
  if (/[A-Z]/.test(tile.type)) {
    const exits = grid.portals.get(tile.type) || [];
    for (const exit of exits) {
      if (exit.x !== pos.x || exit.y !== pos.y) {
        // Assuming one-way to corresponding lower case position? But simplified
        neighbors.push(exit);
      }
    }
  }

  return neighbors;
}

function heuristic(a: Position, b: Position): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function findPath(map: string, start: Position, goal: Position, algorithm: Algorithm = 'astar'): PathResult {
  const grid = parseGrid(map);
  const startTile = grid.tiles[start.y][start.x];
  const goalTile = grid.tiles[goal.y][goal.x];

  if (!startTile.isWalkable || !goalTile.isWalkable) {
    return { path: [], cost: 0, visited: 0, algorithm };
  }

  const openSet: Position[] = [start];
  const cameFrom = new Map<string, Position>();
  const gScore = new Map<string, number>();
  const fScore = new Map<string, number>();
  const visited = new Set<string>();

  const key = (p: Position) => `${p.x},${p.y}`;
  gScore.set(key(start), 0);
  fScore.set(key(start), heuristic(start, goal));

  let visitedCount = 0;

  while (openSet.length > 0) {
    // For BFS, we use queue (FIFO), for others priority
    let current: Position;
    if (algorithm === 'bfs') {
      current = openSet.shift()!;
    } else {
      let lowest = Infinity;
      let lowestIndex = 0;
      for (let i = 0; i < openSet.length; i++) {
        const f = fScore.get(key(openSet[i])) || Infinity;
        if (f < lowest) {
          lowest = f;
          lowestIndex = i;
        }
      }
      current = openSet.splice(lowestIndex, 1)[0];
    }

    const currKey = key(current);
    visited.add(currKey);
    visitedCount++;

    if (current.x === goal.x && current.y === goal.y) {
      // Reconstruct path
      const path: Position[] = [];
      let temp = current;
      while (cameFrom.has(key(temp))) {
        path.unshift(temp);
        temp = cameFrom.get(key(temp))!;
      }
      path.unshift(start);
      return { path, cost: gScore.get(currKey) || 0, visited: visitedCount, algorithm };
    }

    for (const neighbor of getNeighbors(grid, current, algorithm)) {
      const nKey = key(neighbor);
      const tile = grid.tiles[neighbor.y][neighbor.x];
      let tentativeG = (gScore.get(currKey) || Infinity) + (algorithm === 'bfs' ? 1 : tile.weight);

      if (tentativeG < (gScore.get(nKey) || Infinity)) {
        cameFrom.set(nKey, current);
        gScore.set(nKey, tentativeG);
        fScore.set(nKey, tentativeG + (algorithm === 'astar' ? heuristic(neighbor, goal) : 0));

        if (!openSet.some(p => p.x === neighbor.x && p.y === neighbor.y)) {
          openSet.push(neighbor);
        }
      }
    }
  }

  return { path: [], cost: 0, visited: visitedCount, algorithm };
}

// CLI helper
export function solveFromFile(filePath: string, algorithm: Algorithm = 'astar'): PathResult | null {
  try {
    const map = fs.readFileSync(filePath, 'utf8');
    // Assume start is first 'S', goal 'G' - but for simplicity, need to find them
    // This is placeholder, actual would parse S and G
    console.log('Map loaded, implement start/goal detection');
    return null;
  } catch (e) {
    console.error('File read error');
    return null;
  }
}
