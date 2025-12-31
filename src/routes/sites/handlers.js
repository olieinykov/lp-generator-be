import OpenAI from "openai";
import {db} from "../../db/connection.js";
import {blocks, templates} from "../../db/schema.js";
import {eq} from "drizzle-orm";
import AdmZip from "adm-zip";

const openai = new OpenAI({
  apiKey: "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",
  // apiKey: "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",
});

async function downloadAndUnzipBlock(archiveUrl) {
  const response = await fetch(archiveUrl);
  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);

  const zip = new AdmZip(buffer);
  const zipEntries = zip.getEntries();

  const blockData = {};

  zipEntries.forEach(entry => {
    const content = entry.getData().toString('utf8');

    if (entry.entryName === 'definition.json') {
      blockData.definition = JSON.parse(content);
    } else if (entry.entryName === 'template.html') {
      blockData.html = content;
    } else if (entry.entryName === 'styles.css') {
      blockData.css = content;
    }
  });

  return blockData;
}

function generateMockData(variables) {
  const mockData = {};

  variables.forEach(variable => {
    if (variable.type === 'image') {
      mockData[variable.name] = {
        src: `https://picsum.photos/seed/${Math.random().toString(36).substring(7)}/800/600`,
        alt: variable.name || 'Image'
      };
    } else if (variable.type === 'link') {
      mockData[variable.name] = {
        value: '#',
        label: variable.name || 'Link'
      };
    } else if (variable.type === 'text') {
      mockData[variable.name] = `Sample ${variable.name}`;
    }
  });

  return mockData;
}

function fillVariables(html, variables) {
  const mockData = generateMockData(variables);
  let filledHtml = html;

  Object.keys(mockData).forEach(varName => {
    const varData = mockData[varName];
    Object.keys(varData).forEach(prop => {
      const placeholder = `\${data.${varName}.${prop}}`;
      filledHtml = filledHtml.replaceAll(placeholder, varData[prop]);
    });
  });

  return filledHtml;
}

export const createSite = async (request, reply) => {
  try {
    const { prompt, templatesIds } = request.body;

    const template = await db.query.templates.findFirst({
      where: eq(templates.id, templatesIds[0]),
    });

    if (!template || !template.definition?.blocks) {
      return reply.status(404).send({ error: 'Template not found' });
    }

    let allStyles = '';
    let allHtml = '';

    for (const blockDef of template.definition.blocks) {
      const blocksOfType = await db
          .select()
          .from(blocks)
          .where(eq(blocks.category, blockDef.type));

      if (blocksOfType.length > 0) {
        const randomBlock = blocksOfType[Math.floor(Math.random() * blocksOfType.length)];
        const blockData = await downloadAndUnzipBlock(randomBlock.archiveUrl);
        const filledHtml = fillVariables(blockData.html, blockData.definition.variables);

        allHtml += filledHtml + '\n';

        allStyles += blockData.css + '\n';
      }
    }

    const generatedSite = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Generated Site</title>
  <style>
    * {
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    }
    ${allStyles}
  </style>
</head>
<body>
${allHtml}
</body>
</html>`;

    return reply.status(201).type('text/html').send(generatedSite);

  } catch (error) {
    console.log("error", error);
    return reply.status(500).send({ error: error.message });
  }
};