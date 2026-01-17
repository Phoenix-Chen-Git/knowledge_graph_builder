import { logInfo } from "@/logger";
import { z } from "zod";
import { createTool } from "./SimpleTool";
import { TFile } from "obsidian";

/**
 * Knowledge Graph Tools for LLM-powered graph operations
 * These tools enable intelligent analysis and manipulation of the knowledge graph
 */

// Schema for analyzing a note's position in the graph
const analyzeNoteGraphSchema = z.object({
  notePath: z.string().describe("Path to the note to analyze"),
});

/**
 * Analyze a note's position and connections in the knowledge graph
 */
export const analyzeNoteGraphTool = createTool({
  name: "analyzeNoteGraph",
  description:
    "Analyze a note's position in the knowledge graph, including incoming/outgoing links and centrality",
  schema: analyzeNoteGraphSchema,
  handler: async ({ notePath }) => {
    logInfo(`Analyzing graph position for note: ${notePath}`);

    const file = app.vault.getAbstractFileByPath(notePath);
    if (!file || !(file instanceof TFile)) {
      return JSON.stringify({
        success: false,
        error: `Note not found: ${notePath}`,
      });
    }

    // Get backlinks (incoming links)
    const backlinks = app.metadataCache.getBacklinksForFile(file);
    const backlinkData = backlinks?.data || new Map();
    const incomingLinks = Array.from(backlinkData.keys()).map((path) => ({
      path,
      count: backlinkData.get(path)?.length || 0,
    }));

    // Get outgoing links
    const cache = app.metadataCache.getFileCache(file);
    const outgoingLinks =
      cache?.links?.map((link) => ({
        path: link.link,
        displayText: link.displayText || link.link,
      })) || [];

    // Get tags
    const tags = cache?.tags?.map((tag) => tag.tag) || [];
    const frontmatterTags = cache?.frontmatter?.tags || [];
    const allTags = [...new Set([...tags, ...frontmatterTags])];

    // Calculate basic centrality metrics
    const inDegree = incomingLinks.length;
    const outDegree = outgoingLinks.length;
    const totalDegree = inDegree + outDegree;

    return JSON.stringify({
      success: true,
      notePath,
      metrics: {
        incomingLinks: inDegree,
        outgoingLinks: outDegree,
        totalConnections: totalDegree,
        tags: allTags.length,
      },
      incomingLinks: incomingLinks.slice(0, 20), // Limit to top 20
      outgoingLinks: outgoingLinks.slice(0, 20),
      tags: allTags,
      analysis: {
        isHub: inDegree > 5, // More than 5 incoming links
        isConnector: outDegree > 5, // More than 5 outgoing links
        isOrphan: totalDegree === 0,
        isWellConnected: totalDegree > 10,
      },
    });
  },
});

// Schema for finding similar notes
const findSimilarNotesSchema = z.object({
  notePath: z.string().describe("Path to the note to find similar notes for"),
  maxResults: z
    .number()
    .optional()
    .describe("Maximum number of similar notes to return (default: 10)"),
});

/**
 * Find notes similar to a given note based on content, tags, and links
 */
export const findSimilarNotesTool = createTool({
  name: "findSimilarNotes",
  description:
    "Find notes similar to a given note based on semantic similarity, shared tags, and link patterns",
  schema: findSimilarNotesSchema,
  handler: async ({ notePath, maxResults = 10 }) => {
    logInfo(`Finding similar notes to: ${notePath}`);

    const file = app.vault.getAbstractFileByPath(notePath);
    if (!file || !(file instanceof TFile)) {
      return JSON.stringify({
        success: false,
        error: `Note not found: ${notePath}`,
      });
    }

    const cache = app.metadataCache.getFileCache(file);
    // const content = await app.vault.read(file); // unused

    // Extract tags from the source note
    const sourceTags = new Set([
      ...(cache?.tags?.map((tag) => tag.tag) || []),
      ...(cache?.frontmatter?.tags || []),
    ]);

    // Extract links from the source note
    const sourceLinks = new Set(cache?.links?.map((link) => link.link) || []);

    // Find similar notes by comparing tags and links
    const allFiles = app.vault.getMarkdownFiles();
    const similarities: Array<{
      path: string;
      score: number;
      sharedTags: string[];
      sharedLinks: string[];
    }> = [];

    for (const otherFile of allFiles) {
      if (otherFile.path === notePath) continue;

      const otherCache = app.metadataCache.getFileCache(otherFile);
      const otherTags = new Set([
        ...(otherCache?.tags?.map((tag) => tag.tag) || []),
        ...(otherCache?.frontmatter?.tags || []),
      ]);
      const otherLinks = new Set(otherCache?.links?.map((link) => link.link) || []);

      // Calculate shared tags and links
      const sharedTags = Array.from(sourceTags).filter((tag) => otherTags.has(tag));
      const sharedLinks = Array.from(sourceLinks).filter((link) => otherLinks.has(link));

      // Simple scoring: shared tags + shared links
      const score = sharedTags.length * 2 + sharedLinks.length;

      if (score > 0) {
        similarities.push({
          path: otherFile.path,
          score,
          sharedTags,
          sharedLinks,
        });
      }
    }

    // Sort by score and limit results
    similarities.sort((a, b) => b.score - a.score);
    const topSimilar = similarities.slice(0, maxResults);

    return JSON.stringify({
      success: true,
      notePath,
      similarNotes: topSimilar,
      totalFound: similarities.length,
    });
  },
});

// Schema for suggesting new connections
const suggestConnectionsSchema = z.object({
  notePath: z.string().describe("Path to the note to suggest connections for"),
  maxSuggestions: z.number().optional().describe("Maximum number of suggestions (default: 10)"),
});

/**
 * Suggest potential connections for a note based on content analysis
 */
export const suggestConnectionsTool = createTool({
  name: "suggestConnections",
  description:
    "Suggest potential connections for a note based on content, tags, and existing graph structure",
  schema: suggestConnectionsSchema,
  handler: async ({ notePath, maxSuggestions = 10 }) => {
    logInfo(`Suggesting connections for: ${notePath}`);

    const file = app.vault.getAbstractFileByPath(notePath);
    if (!file || !(file instanceof TFile)) {
      return JSON.stringify({
        success: false,
        error: `Note not found: ${notePath}`,
      });
    }

    const cache = app.metadataCache.getFileCache(file);
    const existingLinks = new Set(cache?.links?.map((link) => link.link) || []);

    // Get backlinks
    const backlinks = app.metadataCache.getBacklinksForFile(file);
    const backlinkData = backlinks?.data || new Map();
    const incomingLinks = new Set(Array.from(backlinkData.keys()));

    // Find similar notes (excluding already linked ones)
    const similarResult = await findSimilarNotesTool.call({
      notePath,
      maxResults: maxSuggestions * 2,
    });
    const similarData = JSON.parse(similarResult);

    if (!similarData.success) {
      return similarResult;
    }

    // Filter out already linked notes
    const suggestions = similarData.similarNotes
      .filter((note: any) => !existingLinks.has(note.path) && !incomingLinks.has(note.path))
      .slice(0, maxSuggestions)
      .map((note: any) => ({
        path: note.path,
        reason: `Shares ${note.sharedTags.length} tags and ${note.sharedLinks.length} links`,
        score: note.score,
        sharedTags: note.sharedTags,
        sharedLinks: note.sharedLinks,
      }));

    return JSON.stringify({
      success: true,
      notePath,
      suggestions,
      totalSuggestions: suggestions.length,
    });
  },
});

// Schema for graph insights
const graphInsightsSchema = z.object({
  analysisType: z
    .enum(["overview", "hubs", "orphans", "clusters"])
    .optional()
    .describe(
      "Type of analysis: overview (default), hubs (most connected), orphans (isolated), or clusters (communities)"
    ),
});

/**
 * Generate insights about the entire knowledge graph
 */
export const graphInsightsTool = createTool({
  name: "graphInsights",
  description:
    "Generate insights about the entire knowledge graph structure, including hubs, orphans, and clusters",
  schema: graphInsightsSchema,
  handler: async ({ analysisType = "overview" }) => {
    logInfo(`Generating graph insights: ${analysisType}`);

    const allFiles = app.vault.getMarkdownFiles();
    const totalNotes = allFiles.length;

    // Analyze each note
    const nodeMetrics: Array<{
      path: string;
      inDegree: number;
      outDegree: number;
      totalDegree: number;
      tags: number;
    }> = [];

    for (const file of allFiles) {
      const cache = app.metadataCache.getFileCache(file);
      const backlinks = app.metadataCache.getBacklinksForFile(file);
      const backlinkData = backlinks?.data || new Map();

      const inDegree = Array.from(backlinkData.keys()).length;
      const outDegree = cache?.links?.length || 0;
      const tags = (cache?.tags?.length || 0) + (cache?.frontmatter?.tags?.length || 0);

      nodeMetrics.push({
        path: file.path,
        inDegree,
        outDegree,
        totalDegree: inDegree + outDegree,
        tags,
      });
    }

    // Calculate statistics
    const totalConnections = nodeMetrics.reduce((sum, node) => sum + node.totalDegree, 0);
    const avgConnections = totalConnections / totalNotes;

    // Find hubs (highly connected notes)
    const hubs = nodeMetrics
      .filter((node) => node.totalDegree > avgConnections * 2)
      .sort((a, b) => b.totalDegree - a.totalDegree)
      .slice(0, 10);

    // Find orphans (isolated notes)
    const orphans = nodeMetrics.filter((node) => node.totalDegree === 0);

    // Find well-connected notes
    const wellConnected = nodeMetrics.filter((node) => node.totalDegree >= 5).length;

    const insights: any = {
      success: true,
      overview: {
        totalNotes,
        totalConnections,
        averageConnections: avgConnections.toFixed(2),
        wellConnectedNotes: wellConnected,
        orphanedNotes: orphans.length,
        orphanPercentage: ((orphans.length / totalNotes) * 100).toFixed(1) + "%",
      },
    };

    if (analysisType === "hubs" || analysisType === "overview") {
      insights.hubs = hubs.map((node) => ({
        path: node.path,
        connections: node.totalDegree,
        incoming: node.inDegree,
        outgoing: node.outDegree,
      }));
    }

    if (analysisType === "orphans" || analysisType === "overview") {
      insights.orphans = orphans.slice(0, 20).map((node) => ({
        path: node.path,
        tags: node.tags,
      }));
    }

    return JSON.stringify(insights);
  },
});

// Schema for enriching a note with metadata
const enrichNoteSchema = z.object({
  notePath: z.string().describe("Path to the note to enrich"),
  suggestTags: z.boolean().optional().describe("Whether to suggest tags (default: true)"),
  suggestLinks: z.boolean().optional().describe("Whether to suggest links (default: true)"),
});

/**
 * Enrich a note with LLM-suggested metadata (tags, links, etc.)
 * This tool prepares data for LLM to generate suggestions
 */
export const enrichNoteTool = createTool({
  name: "enrichNote",
  description: "Prepare note enrichment data for LLM to suggest tags, links, and metadata",
  schema: enrichNoteSchema,
  handler: async ({ notePath, suggestTags = true, suggestLinks = true }) => {
    logInfo(`Enriching note: ${notePath}`);

    const file = app.vault.getAbstractFileByPath(notePath);
    if (!file || !(file instanceof TFile)) {
      return JSON.stringify({
        success: false,
        error: `Note not found: ${notePath}`,
      });
    }

    const cache = app.metadataCache.getFileCache(file);
    const content = await app.vault.read(file);

    // Get existing tags
    const existingTags = [
      ...(cache?.tags?.map((tag) => tag.tag) || []),
      ...(cache?.frontmatter?.tags || []),
    ];

    // Get all tags in the vault for suggestions
    const allTags = new Set<string>();
    if (suggestTags) {
      const allFiles = app.vault.getMarkdownFiles();
      for (const otherFile of allFiles) {
        const otherCache = app.metadataCache.getFileCache(otherFile);
        otherCache?.tags?.forEach((tag) => allTags.add(tag.tag));
        otherCache?.frontmatter?.tags?.forEach((tag: string) => allTags.add(tag));
      }
    }

    // Get similar notes for link suggestions
    let similarNotes: any[] = [];
    if (suggestLinks) {
      const similarResult = await findSimilarNotesTool.call({ notePath, maxResults: 10 });
      const similarData = JSON.parse(similarResult);
      if (similarData.success) {
        similarNotes = similarData.similarNotes;
      }
    }

    return JSON.stringify({
      success: true,
      notePath,
      noteContent: content.slice(0, 2000), // First 2000 chars for context
      existingTags,
      availableTags: Array.from(allTags).slice(0, 50), // Top 50 tags
      similarNotes: similarNotes.slice(0, 5),
      suggestions: {
        tags: suggestTags,
        links: suggestLinks,
      },
    });
  },
});

export const KNOWLEDGE_GRAPH_TOOLS = [
  analyzeNoteGraphTool,
  findSimilarNotesTool,
  suggestConnectionsTool,
  graphInsightsTool,
  enrichNoteTool,
];
