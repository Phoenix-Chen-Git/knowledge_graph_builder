import { TFile } from "obsidian";
import { APPLY_VIEW_TYPE } from "@/components/composer/ApplyView";
import { diffTrimmedLines } from "diff";
import { ApplyViewResult } from "@/types";
import { z } from "zod";
import { createTool } from "./SimpleTool";
import { ensureFolderExists } from "@/utils";
import { getSettings } from "@/settings/model";
import { logInfo, logError } from "@/logger";

// Use require for Node built-ins (available in Electron)
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { exec } = require("child_process");
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { promisify } = require("util");
const execAsync = promisify(exec);

/**
 * Creates an automatic git commit before a risky file operation.
 * This allows users to recover from accidental deletions or moves.
 * @param vaultPath - The absolute path to the vault
 * @param action - Description of the action being performed
 * @returns true if commit was created, false if not a git repo or failed
 */
async function gitCommitBeforeRiskyAction(vaultPath: string, action: string): Promise<boolean> {
  try {
    // Check if vault is a git repo
    await execAsync("git rev-parse --is-inside-work-tree", { cwd: vaultPath });

    // Stage all changes and create commit
    const commitMessage = `[Auto-backup] ${action}`;
    await execAsync(`git add -A && git commit -m "${commitMessage}" --allow-empty`, {
      cwd: vaultPath,
    });

    logInfo(`Git auto-commit created: ${commitMessage}`);
    return true;
  } catch (error: any) {
    // Not a git repo or git command failed - this is fine, just skip
    if (error?.message?.includes("not a git repository")) {
      logInfo("Vault is not a git repository, skipping auto-commit");
    } else if (error?.message?.includes("nothing to commit")) {
      logInfo("No changes to commit before action");
    } else {
      logError("Git auto-commit failed:", error);
    }
    return false;
  }
}

async function getFile(file_path: string): Promise<TFile> {
  let file = app.vault.getAbstractFileByPath(file_path);
  if (file && file instanceof TFile) {
    return file;
  }

  // Handle case where path exists but is not a file (e.g., it's a folder)
  if (file && !(file instanceof TFile)) {
    throw new Error(`Path "${file_path}" exists but is not a file`);
  }

  try {
    const folder = file_path.includes("/") ? file_path.split("/").slice(0, -1).join("/") : "";
    if (folder) {
      await ensureFolderExists(folder);
    }

    // Double-check if file was created by another process
    file = app.vault.getAbstractFileByPath(file_path);
    if (file && file instanceof TFile) {
      return file;
    }

    file = await app.vault.create(file_path, "");
    if (!(file instanceof TFile)) {
      throw new Error(`Failed to create file: unexpected type returned for "${file_path}"`);
    }

    return file;
  } catch (error) {
    throw new Error(`Failed to get or create file "${file_path}": ${error.message}`);
  }
}

/**
 * Show the ApplyView preview UI for file changes and return the user decision.
 * @param file_path - Vault-relative path to the file
 * @param content - Target content to compare against current file content
 */
async function show_preview(file_path: string, content: string): Promise<ApplyViewResult> {
  const file = await getFile(file_path);
  const activeFile = app.workspace.getActiveFile();

  if (file && (!activeFile || activeFile.path !== file_path)) {
    // If target file is not the active file, open the target file in the current leaf
    await app.workspace.getLeaf().openFile(file as TFile);
  }

  let originalContent = "";
  if (file) {
    originalContent = await app.vault.read(file as TFile);
  }
  const changes = diffTrimmedLines(originalContent, content, {
    newlineIsToken: true,
  });
  // Return a promise that resolves when the user makes a decision
  return new Promise((resolve) => {
    // Open the Apply View in a new leaf with the processed content and the callback
    const leaf = app.workspace.getLeaf(true);
    leaf.setViewState({
      type: APPLY_VIEW_TYPE,
      active: true,
      state: {
        changes: changes,
        path: file_path,
        resultCallback: (result: ApplyViewResult) => {
          resolve(result);
        },
      },
    });
  });
}

// Define Zod schema for writeToFile
const writeToFileSchema = z.object({
  path: z.string().describe(`(Required) The path to the file to write to. 
          The path must end with explicit file extension, such as .md or .canvas .
          Prefer to create new files in existing folders or root folder unless the user's request specifies otherwise.
          The path must be relative to the root of the vault.`),
  content: z.union([z.string(), z.object({}).passthrough()])
    .describe(`(Required) The content to write to the file. Can be either a string or an object.
          ALWAYS provide the COMPLETE intended content of the file, without any truncation or omissions. 
          You MUST include ALL parts of the file, even if they haven't been modified.

          # For string content
          * Use when writing text files like .md, .txt, etc.
          
          # For object content  
          * Use when writing structured data files like .json, .canvas, etc.
          * The object will be automatically converted to JSON string format
          
          # Canvas JSON Format (JSON Canvas spec 1.0)
          Required node fields: id, type, x, y, width, height
          Node types: "text" (needs text), "file" (needs file), "link" (needs url), "group" (optional label)
          Optional node fields: color (hex #FF0000 or preset "1"-"6"), subpath (file nodes, starts with #)
          Required edge fields: id, fromNode, toNode
          Optional edge fields: fromSide/toSide ("top"/"right"/"bottom"/"left"), fromEnd/toEnd ("none"/"arrow"), color, label
          All IDs must be unique. Edge nodes must reference existing node IDs.
          
          Example:
          {
            "nodes": [
              {"id": "1", "type": "text", "text": "Hello", "x": 0, "y": 0, "width": 200, "height": 50},
              {"id": "2", "type": "file", "file": "note.md", "subpath": "#heading", "x": 250, "y": 0, "width": 200, "height": 100, "color": "2"},
              {"id": "3", "type": "group", "label": "Group", "x": 0, "y": 100, "width": 300, "height": 150}
            ],
            "edges": [
              {"id": "e1-2", "fromNode": "1", "toNode": "2", "fromSide": "right", "toSide": "left", "color": "3", "label": "links to"}
            ]
          }`),
  confirmation: z
    .preprocess((val) => {
      if (typeof val === "string") {
        const lc = val.trim().toLowerCase();
        if (lc === "true") return true;
        if (lc === "false") return false;
      }
      return val;
    }, z.boolean())
    .optional()
    .default(true)
    .describe(
      `(Optional) Whether to ask for change confirmation with preview UI before writing changes. Default: true. Set to false to skip preview and apply changes immediately.`
    ),
});

const writeToFileTool = createTool({
  name: "writeToFile",
  description: `Request to write content to a file at the specified path and show the changes in a Change Preview UI.

      # Steps to find the the target path
      1. Extract the target file information from user message and find out the file path from the context.
      2. If target file is not specified, use the active note as the target file.
      3. If still failed to find the target file or the file path, ask the user to specify the target file.
      `,
  schema: writeToFileSchema,
  handler: async ({ path, content, confirmation = true }) => {
    // Convert object content to JSON string if needed
    const contentString = typeof content === "string" ? content : JSON.stringify(content, null, 2);

    // Check if auto-accept edits is enabled in settings
    const settings = getSettings();
    const shouldBypassConfirmation = settings.autoAcceptEdits || confirmation === false;

    if (shouldBypassConfirmation) {
      try {
        const file = await getFile(path);
        await app.vault.modify(file, contentString);
        return JSON.stringify({
          result: "accepted" as ApplyViewResult,
          message:
            "File changes applied without preview. Do not retry or attempt alternative approaches to modify this file in response to the current user request.",
        });
      } catch (error) {
        return JSON.stringify({
          result: "failed" as ApplyViewResult,
          message: `Error writing to file without preview: ${error?.message || error}`,
        });
      }
    }

    const result = await show_preview(path, contentString);
    // Simple JSON wrapper for consistent parsing
    return JSON.stringify({
      result: result,
      message: `File change result: ${result}. Do not retry or attempt alternative approaches to modify this file in response to the current user request.`,
    });
  },
  timeoutMs: 0, // no timeout
});

const replaceInFileSchema = z.object({
  path: z
    .string()
    .describe(
      `(Required) The path of the file to modify (relative to the root of the vault and include the file extension).`
    ),
  diff: z.string()
    .describe(`(Required) One or more SEARCH/REPLACE blocks. Each block MUST follow this exact format with these exact markers:

------- SEARCH
[exact content to find, including all whitespace and indentation]
=======
[new content to replace with]
+++++++ REPLACE

WHEN TO USE THIS TOOL vs writeToFile:
- Use replaceInFile for: small edits, fixing typos, updating specific sections, targeted changes
- Use writeToFile for: creating new files, major rewrites, when you can't identify specific text to replace

CRITICAL RULES:
1. SEARCH content must match EXACTLY - every character, space, and line break
2. Use the exact markers: "------- SEARCH", "=======", "+++++++ REPLACE"
3. For multiple changes, include multiple SEARCH/REPLACE blocks in order
4. Keep blocks concise - include only the lines being changed plus minimal context

COMMON MISTAKES TO AVOID:
- Wrong: Using different markers like "---- SEARCH" or "SEARCH -------"
- Wrong: Including too many unchanged lines
- Wrong: Not matching whitespace/indentation exactly`),
});

/**
 * Normalizes line endings to LF (\n) for consistent string matching.
 * This helps avoid issues with mixed line endings (CRLF vs LF).
 */
function normalizeLineEndings(text: string): string {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

/**
 * Performs line ending aware text replacement.
 * Normalizes line endings for matching but preserves the original line ending style.
 */
function replaceWithLineEndingAwareness(
  content: string,
  searchText: string,
  replaceText: string
): string {
  // Detect the predominant line ending style in the original content
  const crlfCount = (content.match(/\r\n/g) || []).length;
  const lfCount = (content.match(/(?<!\r)\n/g) || []).length;
  const usesCrlf = crlfCount > lfCount;

  // Normalize for matching
  const normalizedContent = normalizeLineEndings(content);
  const normalizedSearchText = normalizeLineEndings(searchText);
  const normalizedReplaceText = normalizeLineEndings(replaceText);

  // Perform replacement on normalized content
  const resultNormalized = normalizedContent.replaceAll(
    normalizedSearchText,
    normalizedReplaceText
  );

  // Convert back to original line ending style if CRLF was predominant
  if (usesCrlf) {
    return resultNormalized.replace(/\n/g, "\r\n");
  }

  return resultNormalized;
}

const replaceInFileTool = createTool({
  name: "replaceInFile",
  description: `Request to replace sections of content in an existing file using SEARCH/REPLACE blocks that define exact changes to specific parts of the file. This tool should be used when you need to make targeted changes to specific parts of a LARGE file.`,
  schema: replaceInFileSchema,
  handler: async ({ path, diff }: { path: string; diff: string }) => {
    const file = app.vault.getAbstractFileByPath(path);

    if (!file || !(file instanceof TFile)) {
      return `File not found at path: ${path}. Please check the file path and try again.`;
    }

    try {
      const originalContent = await app.vault.read(file);
      let modifiedContent = originalContent;

      // Reject this tool if the original content is small
      const MIN_FILE_SIZE_FOR_REPLACE = 3000;
      if (originalContent.length < MIN_FILE_SIZE_FOR_REPLACE) {
        return `File is too small to use this tool. Please use writeToFile instead.`;
      }

      // Parse SEARCH/REPLACE blocks from diff
      const searchReplaceBlocks = parseSearchReplaceBlocks(diff);

      if (searchReplaceBlocks.length === 0) {
        return `No valid SEARCH/REPLACE blocks found in diff. Please use the correct format with ------- SEARCH, =======, and +++++++ REPLACE markers. \n diff: ${diff}`;
      }

      let changesApplied = 0;

      // Apply each SEARCH/REPLACE block in order
      for (const block of searchReplaceBlocks) {
        let { searchText, replaceText } = block;

        // Check if the search text exists in the current content (with line ending normalization)
        const normalizedContent = normalizeLineEndings(modifiedContent);
        const normalizedSearchText = normalizeLineEndings(searchText);

        if (!normalizedContent.includes(normalizedSearchText)) {
          // Handle corner case where the search text is at the end of the file
          if (normalizedContent.includes(normalizedSearchText.trimEnd())) {
            searchText = searchText.trimEnd();
            replaceText = replaceText.trimEnd();
          } else {
            return `Search text not found in file ${path} : "${searchText}".`;
          }
        }

        // Replace all occurrences using line ending aware replacement
        const beforeReplace = modifiedContent;
        modifiedContent = replaceWithLineEndingAwareness(modifiedContent, searchText, replaceText);

        // Check if any replacements were made
        if (modifiedContent !== beforeReplace) {
          changesApplied++;
        }
      }

      if (originalContent === modifiedContent) {
        return `No changes made to ${path}. The search text was not found or replacement resulted in identical content. Call writeToFile instead`;
      }

      // Check if auto-accept edits is enabled in settings
      const settings = getSettings();
      if (settings.autoAcceptEdits) {
        // Bypass preview and apply changes directly
        try {
          await app.vault.modify(file, modifiedContent);
          return JSON.stringify({
            result: "accepted" as ApplyViewResult,
            blocksApplied: changesApplied,
            message: `Applied ${changesApplied} SEARCH/REPLACE block(s) without preview. Do not call this tool again to modify this file in response to the current user request.`,
          });
        } catch (error) {
          return JSON.stringify({
            result: "failed" as ApplyViewResult,
            blocksApplied: changesApplied,
            message: `Error applying changes without preview: ${error?.message || error}`,
          });
        }
      }

      // Show preview of changes
      const result = await show_preview(path, modifiedContent);

      // Simple JSON wrapper with essential info
      return JSON.stringify({
        result: result,
        blocksApplied: changesApplied,
        message: `Applied ${changesApplied} SEARCH/REPLACE block(s) (replacing all occurrences). Result: ${result}. Do not call this tool again to modify this file in response to the current user request.`,
      });
    } catch (error) {
      return `Error performing SEARCH/REPLACE on ${path}: ${error}. Please check the file path and diff format and try again.`;
    }
  },
  timeoutMs: 0, // no timeout
});

/**
 * Helper function to parse SEARCH/REPLACE blocks from diff string.
 *
 * Supports flexible formatting with various line endings and optional newlines.
 *
 * @param diff - The diff string containing SEARCH/REPLACE blocks
 * @returns Array of parsed search/replace text pairs
 *
 * @example
 * // Standard format with newlines:
 * const diff1 = `------- SEARCH
 * old text here
 * =======
 * new text here
 * +++++++ REPLACE`;
 *
 * @example
 * // Flexible format without newlines:
 * const diff2 = `-------SEARCHold text=======new text+++++++REPLACE`;
 *
 * @example
 * // Windows line endings:
 * const diff3 = `------- SEARCH\r\nold text\r\n=======\r\nnew text\r\n+++++++ REPLACE`;
 *
 * @example
 * // Multiple blocks:
 * const diff4 = `------- SEARCH
 * first old text
 * =======
 * first new text
 * +++++++ REPLACE
 *
 * ------- SEARCH
 * second old text
 * =======
 * second new text
 * +++++++ REPLACE`;
 *
 * Regex patterns match:
 * - SEARCH_MARKER: /-{3,}\s*SEARCH\s*(?:\r?\n)?/ → "---SEARCH" to "----------- SEARCH\n"
 * - SEPARATOR: /(?:\r?\n)?={3,}\s*(?:\r?\n)?/ → "===" to "\n========\n"
 * - REPLACE_MARKER: /(?:\r?\n)?\+{3,}\s*REPLACE/ → "+++REPLACE" to "\n+++++++ REPLACE"
 */
function parseSearchReplaceBlocks(
  diff: string
): Array<{ searchText: string; replaceText: string }> {
  const blocks: Array<{ searchText: string; replaceText: string }> = [];

  const SEARCH_MARKER = /-{3,}\s*SEARCH\s*(?:\r?\n)?/;
  const SEPARATOR = /(?:\r?\n)?={3,}\s*(?:\r?\n)?/;
  const REPLACE_MARKER = /(?:\r?\n)?\+{3,}\s*REPLACE/;

  const blockRegex = new RegExp(
    SEARCH_MARKER.source +
      "([\\s\\S]*?)" +
      SEPARATOR.source +
      "([\\s\\S]*?)" +
      REPLACE_MARKER.source,
    "g"
  );

  let match;
  while ((match = blockRegex.exec(diff)) !== null) {
    const searchText = match[1].trim();
    const replaceText = match[2].trim();
    blocks.push({ searchText, replaceText });
  }

  return blocks;
}

// Delete note schema and tool
const deleteNoteSchema = z.object({
  path: z
    .string()
    .describe(
      `(Required) The path of the file to delete (relative to the root of the vault, including file extension like .md)`
    ),
  confirmation: z
    .preprocess((val) => {
      if (typeof val === "string") {
        const lc = val.trim().toLowerCase();
        if (lc === "true") return true;
        if (lc === "false") return false;
      }
      return val;
    }, z.boolean())
    .optional()
    .default(true)
    .describe(
      `(Optional) Whether to ask for confirmation before deleting. Default: true. Set to false to skip confirmation.`
    ),
});

const deleteNoteTool = createTool({
  name: "deleteNote",
  description: `Delete a note (file) from the vault. Use this tool when the user explicitly asks to delete or remove a note/file. Creates an automatic git backup commit before deletion if the vault is a git repository.`,
  schema: deleteNoteSchema,
  handler: async ({ path, confirmation = true }) => {
    const file = app.vault.getAbstractFileByPath(path);

    if (!file || !(file instanceof TFile)) {
      return JSON.stringify({
        success: false,
        message: `File not found at path: ${path}. Please check the file path and try again.`,
      });
    }

    try {
      // Create git backup before deletion
      const vaultPath = (app.vault.adapter as any).basePath;
      const gitBackup = await gitCommitBeforeRiskyAction(vaultPath, `Before deleting: ${path}`);

      await app.vault.trash(file, true); // Move to trash instead of permanent delete

      const gitMessage = gitBackup ? " A git backup was created before deletion." : "";

      return JSON.stringify({
        success: true,
        gitBackup,
        message: `File "${path}" has been moved to trash.${gitMessage} You can restore it from Obsidian's .trash folder or use git to recover.`,
      });
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        message: `Error deleting file: ${error?.message || error}`,
      });
    }
  },
  timeoutMs: 10000,
});

// Move/Rename note schema and tool
const moveNoteSchema = z.object({
  sourcePath: z
    .string()
    .describe(
      `(Required) The current path of the file to move (relative to the root of the vault, including file extension like .md)`
    ),
  destinationPath: z
    .string()
    .describe(
      `(Required) The new path for the file (relative to the root of the vault, including file extension). Can be in a different folder or just a rename in the same folder.`
    ),
});

const moveNoteTool = createTool({
  name: "moveNote",
  description: `Move or rename a note (file) in the vault. Use this tool when the user asks to move, rename, or reorganize files. This tool automatically updates all internal links pointing to the moved file. Creates an automatic git backup commit before the move if the vault is a git repository.`,
  schema: moveNoteSchema,
  handler: async ({ sourcePath, destinationPath }) => {
    const file = app.vault.getAbstractFileByPath(sourcePath);

    if (!file || !(file instanceof TFile)) {
      return JSON.stringify({
        success: false,
        message: `Source file not found at path: ${sourcePath}. Please check the file path and try again.`,
      });
    }

    // Check if destination already exists
    const existingFile = app.vault.getAbstractFileByPath(destinationPath);
    if (existingFile) {
      return JSON.stringify({
        success: false,
        message: `Destination path "${destinationPath}" already exists. Please choose a different destination.`,
      });
    }

    try {
      // Ensure destination folder exists
      const destFolder = destinationPath.includes("/")
        ? destinationPath.split("/").slice(0, -1).join("/")
        : "";
      if (destFolder) {
        await ensureFolderExists(destFolder);
      }

      // Create git backup before move
      const vaultPath = (app.vault.adapter as any).basePath;
      const gitBackup = await gitCommitBeforeRiskyAction(
        vaultPath,
        `Before moving: ${sourcePath} -> ${destinationPath}`
      );

      // Use fileManager.renameFile which updates all links
      await app.fileManager.renameFile(file, destinationPath);

      const gitMessage = gitBackup ? " A git backup was created before the move." : "";

      return JSON.stringify({
        success: true,
        gitBackup,
        oldPath: sourcePath,
        newPath: destinationPath,
        message: `File moved from "${sourcePath}" to "${destinationPath}". All internal links have been updated.${gitMessage}`,
      });
    } catch (error: any) {
      return JSON.stringify({
        success: false,
        message: `Error moving file: ${error?.message || error}`,
      });
    }
  },
  timeoutMs: 10000,
});

// List recent file operations from git history
const listRecentFileOperationsSchema = z.object({
  limit: z
    .number()
    .optional()
    .default(10)
    .describe("Maximum number of operations to show (default: 10)"),
});

const listRecentFileOperationsTool = createTool({
  name: "listRecentFileOperations",
  description: `List recent file operations (delete/move) from git history. Shows [Auto-backup] commits that can be undone. Use this to find operations the user wants to undo or recover.`,
  schema: listRecentFileOperationsSchema,
  handler: async ({ limit = 10 }) => {
    try {
      const vaultPath = (app.vault.adapter as any).basePath;

      // Get recent Auto-backup commits
      const { stdout } = await execAsync(
        `git log --oneline --grep="\\[Auto-backup\\]" -${limit} --format="%H|%ar|%s"`,
        { cwd: vaultPath }
      );

      if (!stdout.trim()) {
        return JSON.stringify({
          success: true,
          operations: [],
          message:
            "No recent file operations found in git history. The vault may not be a git repository or no operations have been recorded yet.",
        });
      }

      const operations = stdout
        .trim()
        .split("\n")
        .map((line: string, index: number) => {
          const [hash, timeAgo, ...messageParts] = line.split("|");
          const message = messageParts.join("|");

          // Parse action type and file path from message
          let actionType = "unknown";
          let filePath = "";
          let destPath = "";

          if (message.includes("Before deleting:")) {
            actionType = "delete";
            filePath = message.replace("[Auto-backup] Before deleting: ", "").trim();
          } else if (message.includes("Before moving:")) {
            actionType = "move";
            const paths = message.replace("[Auto-backup] Before moving: ", "").trim();
            const [src, dst] = paths.split(" -> ");
            filePath = src?.trim() || "";
            destPath = dst?.trim() || "";
          }

          return {
            index: index + 1,
            hash: hash.trim(),
            timeAgo: timeAgo.trim(),
            actionType,
            filePath,
            destPath,
            fullMessage: message,
          };
        });

      return JSON.stringify({
        success: true,
        operations,
        message: `Found ${operations.length} recent file operation(s). Use undoFileOperation with the commit hash to recover files.`,
      });
    } catch (error: any) {
      if (error?.message?.includes("not a git repository")) {
        return JSON.stringify({
          success: false,
          message: "This vault is not a git repository. File operation history is not available.",
        });
      }
      return JSON.stringify({
        success: false,
        message: `Error reading git history: ${error?.message || error}`,
      });
    }
  },
  timeoutMs: 10000,
});

// Undo a file operation by recovering from git
const undoFileOperationSchema = z.object({
  commitHash: z
    .string()
    .describe("The git commit hash of the [Auto-backup] commit (from listRecentFileOperations)"),
  filePath: z
    .string()
    .describe("The file path to recover (the original path before the operation)"),
});

const undoFileOperationTool = createTool({
  name: "undoFileOperation",
  description: `Undo a file operation by recovering a file from git history. Use listRecentFileOperations first to find the commit hash and file path. This tool recovers the file as it was BEFORE the operation was performed.`,
  schema: undoFileOperationSchema,
  handler: async ({ commitHash, filePath }) => {
    try {
      const vaultPath = (app.vault.adapter as any).basePath;

      // Verify the commit exists and is an Auto-backup commit
      const { stdout: commitInfo } = await execAsync(`git log -1 --format="%s" ${commitHash}`, {
        cwd: vaultPath,
      });

      if (!commitInfo.includes("[Auto-backup]")) {
        return JSON.stringify({
          success: false,
          message: `Commit ${commitHash} is not an [Auto-backup] commit. Please use listRecentFileOperations to find valid commits.`,
        });
      }

      // Check if file already exists
      const existingFile = app.vault.getAbstractFileByPath(filePath);
      if (existingFile) {
        return JSON.stringify({
          success: false,
          message: `File "${filePath}" already exists. Delete or move it first if you want to recover an older version.`,
        });
      }

      // Recover the file from the commit (the state before the operation)
      // We use commitHash^ to get the parent commit (before the backup was made)
      await execAsync(`git checkout ${commitHash}^ -- "${filePath}"`, { cwd: vaultPath });

      // Refresh the vault to see the recovered file
      // Note: Obsidian may need a moment to detect the file

      return JSON.stringify({
        success: true,
        recoveredPath: filePath,
        fromCommit: commitHash,
        message: `File "${filePath}" has been recovered from git history. The file has been restored to its state before the operation. You may need to refresh the file tree to see it.`,
      });
    } catch (error: any) {
      if (error?.message?.includes("did not match any file")) {
        return JSON.stringify({
          success: false,
          message: `File "${filePath}" was not found in git history at that commit. The file path may be incorrect.`,
        });
      }
      return JSON.stringify({
        success: false,
        message: `Error recovering file: ${error?.message || error}`,
      });
    }
  },
  timeoutMs: 10000,
});

export {
  writeToFileTool,
  replaceInFileTool,
  deleteNoteTool,
  moveNoteTool,
  listRecentFileOperationsTool,
  undoFileOperationTool,
  parseSearchReplaceBlocks,
  normalizeLineEndings,
  replaceWithLineEndingAwareness,
};
