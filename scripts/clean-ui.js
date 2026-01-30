#!/usr/bin/env node
import { promises as fs } from "fs";
import path from "path";
import process from "process";

const DEFAULT_INPUT = "workspace-ui";
const DEFAULT_OUTPUT = "ui-cleaned";

const args = process.argv.slice(2);
const inputDir = args[0] || DEFAULT_INPUT;
const outputDir = args[1] || DEFAULT_OUTPUT;

const ASSET_EXTENSIONS = new Set([
  ".css",
  ".png",
  ".jpg",
  ".jpeg",
  ".svg",
  ".gif",
  ".webp",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".eot",
  ".otf",
]);

function stripScripts(html) {
  return html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "");
}

function stripInlineHandlers(html) {
  return html.replace(/\son[a-z]+=("[^"]*"|'[^']*'|[^\s>]+)/gi, "");
}

function isHtml(filePath) {
  return path.extname(filePath).toLowerCase() === ".html";
}

function isSkippableScript(filePath) {
  return [".js", ".jsx", ".ts", ".tsx"].includes(path.extname(filePath).toLowerCase());
}

async function ensureDir(dirPath) {
  await fs.mkdir(dirPath, { recursive: true });
}

async function cleanDirectory(srcDir, destDir, stats) {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(srcDir, entry.name);
    const destPath = path.join(destDir, entry.name);

    if (entry.isDirectory()) {
      await ensureDir(destPath);
      await cleanDirectory(srcPath, destPath, stats);
      continue;
    }

    if (isSkippableScript(srcPath)) {
      stats.skippedScripts.push(path.relative(inputDir, srcPath));
      continue;
    }

    if (isHtml(srcPath)) {
      const raw = await fs.readFile(srcPath, "utf8");
      const cleaned = stripInlineHandlers(stripScripts(raw));
      await fs.writeFile(destPath, cleaned, "utf8");
      stats.cleanedHtml.push(path.relative(inputDir, srcPath));
      continue;
    }

    if (ASSET_EXTENSIONS.has(path.extname(srcPath).toLowerCase())) {
      await fs.copyFile(srcPath, destPath);
      stats.copiedAssets.push(path.relative(inputDir, srcPath));
      continue;
    }
  }
}

async function main() {
  const stats = { cleanedHtml: [], skippedScripts: [], copiedAssets: [] };

  const absInput = path.resolve(inputDir);
  const absOutput = path.resolve(outputDir);

  try {
    const inputStat = await fs.stat(absInput);
    if (!inputStat.isDirectory()) {
      throw new Error(`${inputDir} is not a directory`);
    }
  } catch (error) {
    console.error(`❌ Cannot read input directory: ${inputDir}`);
    console.error(error.message);
    process.exit(1);
  }

  await ensureDir(absOutput);
  await cleanDirectory(absInput, absOutput, stats);

  if (stats.cleanedHtml.length === 0) {
    const placeholder = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Workspace UI</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; padding: 40px; background: #0f1115; color: #e6e8eb; }
    .card { max-width: 720px; margin: 0 auto; padding: 24px; border-radius: 16px; background: #161b22; }
    h1 { margin-top: 0; font-size: 24px; }
    p { line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Workspace UI</h1>
    <p>No HTML files were found in <code>${inputDir}</code>. Add your UI layout files there and re-run this script.</p>
  </div>
</body>
</html>`;
    await fs.writeFile(path.join(absOutput, "index.html"), placeholder, "utf8");
  }

  console.log("✅ UI cleanup complete");
  console.log(JSON.stringify(stats, null, 2));
}

main();