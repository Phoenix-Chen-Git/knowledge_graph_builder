import { TFile } from "obsidian";
import { z } from "zod";
import { logInfo, logError } from "@/logger";
import { createTool } from "./SimpleTool";
import { BrevilabsClient } from "@/LLMProviders/brevilabsClient";
import { FileParserManager } from "./FileParserManager";
import { ensureFolderExists } from "@/utils";

/**
 * Schema for the extracted knowledge structure from a paper
 */
interface ExtractedConcept {
  id: string;
  title: string;
  type: "definition" | "method" | "finding" | "claim" | "evidence" | "limitation" | "future_work";
  content: string;
  keywords: string[];
}

interface ExtractedRelationship {
  from: string; // concept id
  to: string; // concept id
  type: "supports" | "contradicts" | "extends" | "causes" | "requires" | "examples";
  label?: string;
}

interface ExtractedKnowledge {
  title: string;
  abstract: string;
  concepts: ExtractedConcept[];
  relationships: ExtractedRelationship[];
}

/**
 * Generate a unique ID for canvas nodes
 */
function generateId(): string {
  return Math.random().toString(36).substring(2, 10);
}

/**
 * Create canvas JSON from extracted knowledge
 * @internal Reserved for Stage 2 implementation
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function createCanvasFromKnowledge(knowledge: ExtractedKnowledge, noteFolder: string): string {
  const nodes: any[] = [];
  const edges: any[] = [];

  // Node type to color mapping
  const typeColors: Record<string, string> = {
    definition: "1", // Red
    method: "2", // Orange
    finding: "3", // Yellow
    claim: "4", // Green
    evidence: "5", // Cyan
    limitation: "6", // Purple
    future_work: "1", // Red
  };

  // Layout: arrange nodes in a grid
  const cols = 4;
  const nodeWidth = 300;
  const nodeHeight = 150;
  const spacing = 50;

  // Create concept ID to canvas node ID mapping
  const conceptToNodeId: Record<string, string> = {};

  knowledge.concepts.forEach((concept, index) => {
    const nodeId = generateId();
    conceptToNodeId[concept.id] = nodeId;

    const col = index % cols;
    const row = Math.floor(index / cols);

    nodes.push({
      id: nodeId,
      type: "file",
      file: `${noteFolder}/${concept.title.replace(/[\\/:*?"<>|]/g, "_")}.md`,
      x: col * (nodeWidth + spacing),
      y: row * (nodeHeight + spacing),
      width: nodeWidth,
      height: nodeHeight,
      color: typeColors[concept.type] || "1",
    });
  });

  // Create edges for relationships
  knowledge.relationships.forEach((rel) => {
    const fromNodeId = conceptToNodeId[rel.from];
    const toNodeId = conceptToNodeId[rel.to];

    if (fromNodeId && toNodeId) {
      edges.push({
        id: generateId(),
        fromNode: fromNodeId,
        toNode: toNodeId,
        fromSide: "right",
        toSide: "left",
        toEnd: "arrow",
        label: rel.label || rel.type,
      });
    }
  });

  return JSON.stringify({ nodes, edges }, null, 2);
}

/**
 * Create a note content from a concept
 * @internal Reserved for Stage 2 implementation
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars
function createNoteFromConcept(concept: ExtractedConcept, paperTitle: string): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const tags = concept.keywords.map((k) => `#${k.replace(/\s+/g, "_")}`).join(" ");

  return `---
type: ${concept.type}
source: "[[${paperTitle}]]"
tags: [${concept.keywords.map((k) => `"${k}"`).join(", ")}]
---

# ${concept.title}

${concept.content}

---
*Extracted from [[${paperTitle}]]*
`;
}

// Schema for paperToKnowledgeGraph tool
const paperToKnowledgeGraphSchema = z.object({
  paperPath: z.string().describe("Path to the PDF paper file (relative to vault root)"),
  outputFolder: z
    .string()
    .optional()
    .describe("Folder to create notes in (default: same folder as paper with paper name)"),
});

const paperToKnowledgeGraphTool = createTool({
  name: "paperToKnowledgeGraph",
  description: `Convert an academic paper (PDF) into a knowledge graph with atomic notes and a canvas visualization.

This tool:
1. Extracts text from the PDF
2. Uses AI to identify key concepts and their relationships
3. Creates individual notes for each concept (one idea per note)
4. Creates a canvas showing the logical structure

Use this when the user wants to:
- Convert a paper into notes
- Create a knowledge graph from a paper
- Extract key concepts from a PDF
- Visualize paper structure`,
  schema: paperToKnowledgeGraphSchema,
  handler: async ({ paperPath, outputFolder }) => {
    try {
      // Resolve the paper file
      const file = app.vault.getAbstractFileByPath(paperPath);
      if (!file || !(file instanceof TFile)) {
        return JSON.stringify({
          success: false,
          message: `Paper not found at path: ${paperPath}`,
        });
      }

      if (file.extension !== "pdf") {
        return JSON.stringify({
          success: false,
          message: `File is not a PDF: ${paperPath}`,
        });
      }

      logInfo(`Converting paper to knowledge graph: ${paperPath}`);

      // Extract text from PDF
      const brevilabsClient = BrevilabsClient.getInstance();
      const fileParserManager = new FileParserManager(brevilabsClient, app.vault);
      const paperText = await fileParserManager.parseFile(file, app.vault);

      if (!paperText || paperText.length < 100) {
        return JSON.stringify({
          success: false,
          message: "Could not extract sufficient text from the PDF",
        });
      }

      // Determine output folder
      const paperName = file.basename;
      const paperFolder = file.parent?.path || "";
      const targetFolder = outputFolder || `${paperFolder}/${paperName}_knowledge`;

      // Ensure folder exists
      await ensureFolderExists(targetFolder);

      // Return the actual paper content for LLM to process
      // Stage 1: Generate outline only - limit content for faster processing
      const paperContentForLLM = paperText.slice(0, 20000);

      return JSON.stringify({
        success: true,
        action: "analyze_paper_outline",
        stage: 1,
        paperTitle: paperName,
        outputFolder: targetFolder,
        totalChars: paperText.length,
        WARNING:
          "CRITICAL: Use ONLY the paperContent below. DO NOT use any information from previous conversations.",
        paperContent: paperContentForLLM,
        instructions: `
## STAGE 1: Paper Outline Analysis

Read the paperContent carefully. This is the ACTUAL paper: "${paperName}"

Generate a **structured outline** in the chat (NOT files yet):

### 📄 Paper: ${paperName}

**Main Thesis:**
[One sentence summary]

**Key Concepts (to become atomic notes):**
1. [Concept 1] - brief description
2. [Concept 2] - brief description
3. [Concept 3] - brief description
...

**Relationships:**
- [Concept A] → supports → [Concept B]
- [Concept C] → extends → [Concept D]
...

**Suggested Structure:**
- 📁 ${targetFolder}/
  - [List of notes to create]
  - ${paperName}_canvas.canvas

---
After showing the outline, tell the user:
"回复 **'create'** 来生成笔记和Canvas，或告诉我你想调整哪些概念。"
`,
        message: `Analyzing "${paperName}"... Generating outline first. Notes will be created in: ${targetFolder}/`,
      });
    } catch (error: any) {
      logError("Error in paperToKnowledgeGraph:", error);
      return JSON.stringify({
        success: false,
        message: `Error processing paper: ${error?.message || error}`,
      });
    }
  },
  timeoutMs: 60000, // 1 minute timeout for PDF processing
});

export { paperToKnowledgeGraphTool };
