import fs from 'fs';
import { solveBFS, solveDijkstra, solveAStar } from './grid-router';

interface Position {
  x: number;
  y: number;
}

interface SolveResult {
  path: Position[];
  cost: number;
  visited: number;
}

function parseGrid(gridStr: string): string[][] {
  const lines = gridStr.trim().split(/\r?\n/);
  return lines.map(line => line.split(''));
}

function findStartAndEnd(grid: string[][]): { start: Position; end: Position } {
  let start: Position = { x: 0, y: 0 };
  let end: Position = { x: 0, y: 0 };
  for (let y = 0; y < grid.length; y++) {
    for (let x = 0; x < grid[y].length; x++) {
      if (grid[y][x] === 'S') start = { x, y };
      if (grid[y][x] === 'E') end = { x, y };
    }
  }
  return { start, end };
}

function printOverlay(gridStr: string, path: Position[]) {
  const grid = parseGrid(gridStr);
  const pathSet = new Set(path.map(p => `${p.x},${p.y}`));
  for (let y = 0; y < grid.length; y++) {
    let line = '';
    for (let x = 0; x < grid[y].length; x++) {
      const posStr = `${x},${y}`;
      if (pathSet.has(posStr) && grid[y][x] !== 'S' && grid[y][x] !== 'E' && grid[y][x] !== '*') {
        line += '*';
      } else {
        line += grid[y][x];
      }
    }
    console.log(line);
  }
}

function main() {
  const args = process.argv.slice(2);
  let filePath: string | null = null;
  let algo: 'bfs' | 'dijkstra' | 'astar' = 'astar';
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--file' && i + 1 < args.length) {
      filePath = args[++i];
    } else if (args[i] === '--algo' && i + 1 < args.length) {
      const nextAlgo = args[++i];
      if (['bfs', 'dijkstra', 'astar'].includes(nextAlgo)) {
        algo = nextAlgo as 'bfs' | 'dijkstra' | 'astar';
      }
    }
  }

  let gridStr: string;
  if (filePath) {
    gridStr = fs.readFileSync(filePath, 'utf-8');
  } else {
    // Read from stdin
    gridStr = fs.readFileSync(0, 'utf-8');
  }

  const grid = parseGrid(gridStr);
  const { start, end } = findStartAndEnd(grid);

  let result: SolveResult;
  if (algo === 'bfs') {
    result = solveBFS(gridStr, start, end);
  } else if (algo === 'dijkstra') {
    result = solveDijkstra(gridStr, start, end);
  } else {
    result = solveAStar(gridStr, start, end);
  }

  console.log(`Path length: ${result.path.length - 1}`);
  console.log(`Total cost: ${result.cost}`);
  console.log(`Visited nodes: ${result.visited}`);
  console.log('\nPath overlay:');
  printOverlay(gridStr, result.path);
}

if (require.main === module) {
  main();
}

export { main };
