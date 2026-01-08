import { db, supabase } from '../../db/connection.js';
import { blocks, templates, sites, profiles } from '../../db/schema.js';
import { and, asc, count, desc, eq, gte, ilike, lte, sql } from 'drizzle-orm';
import AdmZip from 'adm-zip';
import { alias } from 'drizzle-orm/pg-core';
import { generateAIContent } from '../../utils/aiContentGenerator.js';
import { downloadAndUnzipBlock } from '../../utils/zipHandler.js';
import JSZip from 'jszip';

function fillVariables(html, aiContent) {
	let filledHtml = html;

	Object.keys(aiContent).forEach((varName) => {
		const varData = aiContent[varName];

		Object.keys(varData).forEach((prop) => {
			if (varData[prop] !== null) {
				const placeholder = `\${variables.${varName}.${prop}}`;
				filledHtml = filledHtml.replaceAll(placeholder, varData[prop]);
			}
		});
	});

	return filledHtml;
}

function applyThemeToCss(originalCss, themeVariables) {
	if (!themeVariables || Object.keys(themeVariables).length === 0) {
		return originalCss;
	}

	let updatedCss = originalCss;

	// Ищем :root блок
	const rootMatch = updatedCss.match(/:root\s*\{[\s\S]*?\}/);

	if (rootMatch) {
		// Обновляем переменные в :root
		Object.entries(themeVariables).forEach(([varName, value]) => {
			const regex = new RegExp(`${varName}\\s*:[^;]*;`, 'g');
			const newDeclaration = `${varName}: ${value};`;

			if (updatedCss.includes(varName)) {
				// Заменяем существующую переменную
				updatedCss = updatedCss.replace(regex, newDeclaration);
			} else {
				// Добавляем новую переменную внутрь :root
				updatedCss = updatedCss.replace(/:root\s*\{/, `:root {\n  ${newDeclaration}`);
			}
		});
	} else {
		// Если нет :root, добавляем его в начало
		let newRoot = ':root {\n';
		Object.entries(themeVariables).forEach(([varName, value]) => {
			newRoot += `  ${varName}: ${value};\n`;
		});
		newRoot += '}\n\n';
		updatedCss = newRoot + updatedCss;
	}

	return updatedCss;
}

export const createSite = async (request, reply) => {
	try {
		const { prompt, templatesIds, isActive, name, trafficSource, country, language } =
			request.body;

		const template = await db.query.templates.findFirst({
			where: eq(templates.id, templatesIds[0]),
		});

		if (!template || !template.definition?.blocks) {
			return reply.status(404).send({ error: 'Template not found' });
		}

		let allStyles = '';
		let allHtml = '';
		let tokensInfo;

		// Собираем все CSS переменные из всех блоков
		let allThemeVariables = {};

		for (const blockDef of template.definition.blocks) {
			const blocksOfType = await db
				.select()
				.from(blocks)
				.where(eq(blocks.category, blockDef.type));

			if (blocksOfType.length > 0) {
				const randomBlock = blocksOfType[Math.floor(Math.random() * blocksOfType.length)];
				const blockData = await downloadAndUnzipBlock(randomBlock.archiveUrl);

				const [aiContent, tokens] = await generateAIContent(
					prompt,
					blockData.definition.variables,
					blockDef.type,
				);
				tokensInfo = tokens;
				console.log('AI Content:', JSON.stringify(aiContent, null, 2));

				// Извлекаем theme из AI ответа (если есть)
				const themeVariables = aiContent.theme || {};

				// Объединяем theme переменные (последний блок перезаписывает предыдущие)
				allThemeVariables = { ...allThemeVariables, ...themeVariables };

				// Удаляем theme из aiContent, чтобы fillVariables не пыталась его обработать
				const contentForHtml = { ...aiContent };
				delete contentForHtml.theme;

				const filledHtml = fillVariables(blockData.html, contentForHtml);
				allHtml += filledHtml + '\n';

				// Применяем theme к CSS этого блока
				const updatedCss = applyThemeToCss(blockData.css, themeVariables);
				allStyles += updatedCss + '\n';
			}
		}

		// Если есть theme переменные, но не было :root, добавляем их в начало
		let finalStyles = '';
		if (Object.keys(allThemeVariables).length > 0) {
			finalStyles += ':root {\n';
			Object.entries(allThemeVariables).forEach(([varName, value]) => {
				finalStyles += `  ${varName}: ${value};\n`;
			});
			finalStyles += '}\n\n';
		}
		finalStyles += allStyles;

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
    ${finalStyles}
  </style>
</head>
<body>
${allHtml}
</body>
</html>`;

		const zip = new AdmZip();
		zip.addFile('index.html', Buffer.from(generatedSite, 'utf8'));

		const zipBuffer = zip.toBuffer();
		const fileName = `site-${name}-${new Date().getTime()}.zip`;
		const { data, error } = await supabase.storage.from('sites').upload(fileName, zipBuffer, {
			contentType: 'application/zip',
			upsert: false,
		});

		if (error) {
			throw error;
		}

		const { data: urlData } = supabase.storage.from('sites').getPublicUrl(fileName);

		console.log('urlData.publicUrl', urlData.publicUrl);

		const [siteData] = await db
			.insert(sites)
			.values({
				isDraft: true,
				name: name,
				isActive: isActive,
				trafficSource: trafficSource,
				archiveUrl: urlData.publicUrl,
				country: country,
				language: language,
				definition: template.id,
				prompt: prompt,
				totalTokens: tokensInfo.totalTokens,
				completionTokens: tokensInfo.completionTokens,
				promptTokens: tokensInfo.promptTokens,
				createdBy: '67366103-2833-41a8-aea2-10d589a0705c',
				updatedBy: '67366103-2833-41a8-aea2-10d589a0705c',
			})
			.returning();

		return reply.type('text/html').send(generatedSite);
	} catch (error) {
		console.log('error', error);
		return reply.status(500).send({ error: error.message });
	}
};

// Остальные функции (getAllSites, getOneSite, activateSite) остаются без изменений
// ... [ВСТАВЬТЕ ИХ СЮДА БЕЗ ИЗМЕНЕНИЙ] ...

export const getAllSites = async (request, reply) => {
	// ... существующий код без изменений ...
};

export const getOneSite = async (request, reply) => {
	// ... существующий код без изменений ...
};

export const activateSite = async (request, reply) => {
	// ... существующий код без изменений ...
};