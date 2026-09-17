import fs from "fs/promises";
import path from "path";

export async function scanDirectory(directory) {
  const results = [];

  async function walk(currentDir) {
    let entries;

    try {
      entries = await fs.readdir(currentDir, {
        withFileTypes: true
      });
    } catch (error) {
      console.error(
        `Không thể đọc thư mục: ${currentDir}`,
        error.message
      );
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(
        currentDir,
        entry.name
      );

      if (entry.isDirectory()) {
        await walk(fullPath);
        continue;
      }

      if (!entry.isFile()) {
        continue;
      }

      try {
        const stat = await fs.stat(fullPath);

        results.push({
          name: entry.name,
          path: fullPath,
          size: stat.size,
          modified: stat.mtime.toISOString(),
          extension: path.extname(entry.name)
        });
      } catch (error) {
        console.error(
          `Không thể đọc file: ${fullPath}`,
          error.message
        );
      }
    }
  }

  await walk(directory);

  return results;
}