import { db, supabase } from '../../db/connection.js';
import { blocks, templates, sites, profiles } from '../../db/schema.js';
import { and, asc, count, desc, eq, gte, ilike, lte, sql } from 'drizzle-orm';
import AdmZip from 'adm-zip';
import { alias } from 'drizzle-orm/pg-core';
import JSZip from 'jszip';
import { PRICE_FOR_PROMPTS_OPENAI } from '../../config/constants.js';
import slugify from 'slugify';
import {
	buildSitePages,
	fillPageVariables,
	generatePageBlocksContent,
	generatePageSeo,
	generateTheme,
	getBlockById,
	getBlockByType,
	getBlocks,
	pageBlocksVars,
	prepareBlock,
	prepareGlobalBlocks,
	sumTokens,
	updatePageContentRegex,
} from '../../utils/blocks.js';
import { extractHtmlFiles } from '../../utils/zipHandler.js';

function cutNumber(number, amountAfterDot) {
	const factor = 10 ** amountAfterDot;
	return Math.floor(number * factor) / factor;
}

export const createSite = async (request, reply) => {
	try {
		const { prompt, templateId, isActive, name, trafficSource, country, language } =
			request.body;

		const template = await db.query.templates.findFirst({
			where: eq(templates.id, templateId),
		});

		if (!template) {
			return reply.status(404).send({ error: 'Template not found' });
		}

		const tokensInfo = {
			totalPromptTokens: 0,
			totalCompletionTokens: 0,
			totalTokens: 0,
			falTotalCost: 0,
		};

		const [themeResult, seoDataResults, globalBlocksData] = await Promise.all([
			generateTheme(prompt),
			Promise.all(
				template.definition.pages.map((page) =>
					generatePageSeo(page.title, prompt, language, country).catch((err) => ({
						error: err,
					})),
				),
			),
			(async () => {
				const blocks = await getBlocks(template?.definition?.globals?.blocks);
				return prepareGlobalBlocks(
					blocks,
					template?.definition?.pages,
					prompt,
					country,
					language,
				);
			})(),
		]);

		const { theme: generatedTheme, tokens: themeTokens } = themeResult;
		const globalBlocksMap = new Map(globalBlocksData.map((b) => [b.category, b]));

		const pagesResults = await Promise.all(
			template.definition.pages.map(async (page, pageIndex) => {
				const seoEntry = seoDataResults[pageIndex];
				const pageSeo = Array.isArray(seoEntry) ? seoEntry[0] : {};

				const { pageStructureObj, processBlocks } = await pageBlocksVars(
					page.layout,
					globalBlocksMap,
				);

				const [aiContent, tokens] = await generatePageBlocksContent(
					processBlocks,
					prompt,
					country,
					language,
				);

				const finalPageStructure = fillPageVariables(pageStructureObj, aiContent);

				return {
					pageData: {
						...page,
						finalPageStructure,
						seo: pageSeo,
					},
					tokens,
				};
			}),
		);

		sumTokens(tokensInfo, themeTokens);
		seoDataResults.forEach((res) => Array.isArray(res) && sumTokens(tokensInfo, res[1]));
		globalBlocksData.forEach((b) => sumTokens(tokensInfo, b.tokens));

		const pages = pagesResults.map((res) => {
			sumTokens(tokensInfo, res.tokens);
			return res.pageData;
		});
		const globalCss = { ...generatedTheme };
		//tokensInfo.totalPromptTokens += themeTokens.promptTokens;
		//tokensInfo.totalCompletionTokens += themeTokens.completionTokens;
		//tokensInfo.totalTokens += themeTokens.totalTokens;

		//const seoData = await Promise.all(
		//	template.definition.pages.map(async (page) => {
		//		try {
		//			const [seo, tokens] = await generatePageSeo(
		//				page.title,
		//				prompt,
		//				language,
		//				country,
		//			);
		//			tokensInfo.totalPromptTokens += tokens.promptTokens;
		//			tokensInfo.totalCompletionTokens += tokens.completionTokens;
		//			tokensInfo.totalTokens += tokens.totalTokens;
		//			return {
		//				...seo,
		//			};
		//		} catch (err) {
		//			return err;
		//		}
		//	}),
		//);
		//const globalCss = {
		//	...generatedTheme,
		//	// ...(template?.definition?.globals?.css || {})
		//};

		//const globalBlocks = await getBlocks(template?.definition?.globals?.blocks);
		//const preparedGlobalBlocks = await prepareGlobalBlocks(
		//	globalBlocks,
		//	template?.definition?.pages,
		//	prompt,
		//	country,
		//	language,
		//);
		//preparedGlobalBlocks.forEach((b) => {
		//	tokensInfo.totalPromptTokens += b.tokens.promptTokens;
		//	tokensInfo.totalCompletionTokens += b.tokens.completionTokens;
		//	tokensInfo.totalTokens += b.tokens.totalTokens;
		//});

		//const globalBlocksMap = new Map(preparedGlobalBlocks.map((b) => [b.category, b]));

		//const pages = await Promise.all(
		//	template.definition.pages.map(async (page, pageIndex) => {
		//		const { pageStructureObj, processBlocks } = await pageBlocksVars(
		//			page.layout,
		//			globalBlocksMap,
		//		);
		//		const [aiContent, tokens] = await generatePageBlocksContent(
		//			processBlocks,
		//			prompt,
		//			country,
		//			language,
		//		);
		//		tokensInfo.totalPromptTokens += tokens.promptTokens;
		//		tokensInfo.totalCompletionTokens += tokens.completionTokens;
		//		tokensInfo.totalTokens += tokens.totalTokens;

		//		const finalPageStructure = fillPageVariables(pageStructureObj, aiContent);
		//		return {
		//			...page,
		//			finalPageStructure,
		//			seo: seoData[pageIndex],
		//		};
		//	}),
		//);

		const inputPrice =
			tokensInfo.totalPromptTokens * (PRICE_FOR_PROMPTS_OPENAI.input / 1000000);
		const outputPrice =
			tokensInfo.totalCompletionTokens * (PRICE_FOR_PROMPTS_OPENAI.output / 1000000);
		const totalPrice = inputPrice + outputPrice;

		const sitePages = buildSitePages(pages, globalCss, language, country);
		console.log('sitePages =>', sitePages);
		const zip = new AdmZip();
		sitePages.forEach((page) => {
			zip.addFile(page.filename, Buffer.from(page.html, 'utf8'));
		});
		const zipBuffer = zip.toBuffer();

		const safeName = slugify(`site-${name}-${new Date().getTime()}.zip`, {
			lower: true,
			strict: true,
		});

		const { error: uploadError } = await supabase.storage
			.from('sites')
			.upload(safeName, zipBuffer, {
				contentType: 'application/zip',
				upsert: false,
			});

		if (uploadError) {
			throw uploadError;
		}

		const { data: urlData } = supabase.storage.from('sites').getPublicUrl(safeName);

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
				completionTokens: tokensInfo.totalCompletionTokens,
				promptTokens: tokensInfo.totalPromptTokens,
				inputUsdPrice: cutNumber(inputPrice, 6),
				outputUsdPrice: cutNumber(outputPrice, 6),
				totalUsdPrice: cutNumber(totalPrice, 6),
				createdBy: '67366103-2833-41a8-aea2-10d589a0705c',
				updatedBy: '67366103-2833-41a8-aea2-10d589a0705c',
			})
			.returning();

		return reply.status(201).send({
			data: {
				...siteData,
				previews: sitePages.map((page) => page.html),
				falTotalCost: tokensInfo.falTotalCost,
			},
			success: true,
		});
	} catch (error) {
		console.log('error', error);
		return reply.status(500).send({ error: error.message });
	}
};

export const getAllSites = async (request, reply) => {
	try {
		const {
			page = 1,
			limit = 20,
			searchByName = '',
			searchById = '',
			sortBy = 'createdAt',
			sortOrder = 'desc',
			isActive,
			createdBy,
			updatedBy,
			createdAtFrom,
			createdAtTo,
			updatedAtFrom,
			updatedAtTo,
			createdByUserId,
			updatedByUserId,
		} = request.query;

		const parseDateFilter = (dateString) => {
			if (!dateString) return null;
			const date = new Date(dateString);
			return isNaN(date.getTime()) ? null : date;
		};

		const createdAtFromDate = parseDateFilter(createdAtFrom);
		const createdAtToDate = parseDateFilter(createdAtTo);
		const updatedAtFromDate = parseDateFilter(updatedAtFrom);
		const updatedAtToDate = parseDateFilter(updatedAtTo);

		const offset = (page - 1) * limit;

		const createdByProfile = alias(profiles, 'created_by_profile');
		const updatedByProfile = alias(profiles, 'updated_by_profile');

		const filters = [];

		if (searchByName) filters.push(ilike(blocks.name, `%${searchByName}%`));
		if (searchById) {
			filters.push(sql`CAST(${blocks.id} AS TEXT) ILIKE ${'%' + searchById + '%'}`);
		}
		if (createdBy) filters.push(eq(blocks.createdBy, createdBy));
		if (updatedBy) filters.push(eq(blocks.updatedBy, updatedBy));

		if (createdAtFromDate) filters.push(gte(blocks.createdAt, createdAtFromDate));
		if (createdAtToDate) filters.push(lte(blocks.createdAt, createdAtToDate));
		if (updatedAtFromDate) filters.push(gte(blocks.updatedAt, updatedAtFromDate));
		if (updatedAtToDate) filters.push(lte(blocks.updatedAt, updatedAtToDate));

		if (createdByUserId) filters.push(lte(blocks.createdBy, createdByUserId));
		if (updatedByUserId) filters.push(lte(blocks.updatedBy, updatedByUserId));

		if (isActive === 'true') {
			filters.push(eq(blocks.isActive, true));
		} else if (isActive === 'false') {
			filters.push(eq(blocks.isActive, false));
		}

		const order = (column) => (sortOrder === 'asc' ? asc(column) : desc(column));

		const query = db
			.select({
				id: sites.id,
				name: sites.name,
				isActive: sites.isActive,
				archiveUrl: sites.archiveUrl,
				definition: sites.definition,
				createdAt: sites.createdAt,
				updatedAt: sites.updatedAt,
				promptTokens: sites.promptTokens,
				completionTokens: sites.completionTokens,
				totalTokens: sites.totalTokens,
				totalUsdPrice: sites.totalUsdPrice,
				inputUsdPrice: sites.inputUsdPrice,
				outputUsdPrice: sites.outputUsdPrice,
				createdByEmail: createdByProfile.email,
				createdByUsername: createdByProfile.username,
				updatedByEmail: updatedByProfile.email,
				updatedByUsername: updatedByProfile.username,
			})
			.from(sites)
			.leftJoin(createdByProfile, eq(sites.createdBy, createdByProfile.userId))
			.leftJoin(updatedByProfile, eq(sites.updatedBy, updatedByProfile.userId))
			.where(filters.length ? and(...filters) : undefined)
			.orderBy(order(sites[sortBy]))
			.limit(limit)
			.offset(offset);

		const data = await query;

		const [{ count: totalCount }] = await db
			.select({ count: count() })
			.from(sites)
			.where(filters.length ? and(...filters) : undefined);

		return reply.code(200).send({
			success: true,
			data,
			pagination: {
				page: Number(page),
				limit: Number(limit),
				totalCount,
				totalPages: Math.ceil(totalCount / limit),
				hasNext: page < Math.ceil(totalCount / limit),
				hasPrev: page > 1,
			},
		});
	} catch (error) {
		reply.code(400).send({
			success: false,
			error: error.message,
		});
	}
};

export const getOneSite = async (request, reply) => {
	try {
		const { siteId } = request.params;

		const [site] = await db
			.select()
			.from(sites)
			.where(eq(sites.id, parseInt(siteId)));

		const response = await fetch(site.archiveUrl);
		if (!response.ok) {
			throw new Error(`Failed to download archive: ${response.status}`);
		}
		const responseArrayBuffer = await response.arrayBuffer();
		const zip = await JSZip.loadAsync(responseArrayBuffer);
		const previewFile = zip.file('index.html');
		let preview;
		if (previewFile) {
			preview = await previewFile.async('string');
		}

		reply.send({
			success: true,
			data: {
				...site,
				preview,
			},
		});
	} catch (error) {
		reply.code(500).send({
			success: false,
			error: error.message,
		});
	}
};

export const activateSite = async (request, reply) => {
	try {
		const { siteId } = request.params;

		const [existing] = await db
			.select()
			.from(sites)
			.where(eq(sites.id, Number(siteId)));

		if (!existing) {
			return reply.code(404).send({ success: false, error: 'Site not found' });
		}

		const [updatedSite] = await db
			.update(sites)
			.set({
				isDraft: false,
			})
			.where(eq(sites.id, Number(siteId)))
			.returning();

		reply.send({
			success: true,
			data: updatedSite,
		});
	} catch (error) {
		reply.code(500).send({
			success: false,
			error: error.message,
		});
	}
};

export const regenerateSite = async (request, reply) => {
	try {
		const { siteId } = request.params;
		const { prompt } = request.body;

		const [result] = await db.select().from(sites).where(eq(sites.id, siteId));
		const {
			name,
			definition,
			country,
			language,
			totalTokens: totalTokensDB,
			promptTokens: promptTokensDB,
			completionTokens: completionTokensDB,
		} = result;
		const template = await db.query.templates.findFirst({
			where: eq(templates.id, definition),
		});

		// 		if (!template || !template.definition?.blocks) {
		// 			return reply.status(404).send({ error: 'Template not found' });
		// 		}
		//
		// 		let allStyles = '';
		// 		let allHtml = '';
		// 		let tokensInfo = {
		// 			totalPromptTokens: promptTokensDB,
		// 			totalCompletionTokens: completionTokensDB,
		// 			totalTokens: totalTokensDB,
		// 		};
		//
		// 		let allThemeVariables = {};
		// 		let metaTags = '';
		//
		// 		const blockPromises = template.definition.blocks.map(async (blockDef) => {
		// 			let randomBlockId = null;
		// 			try {
		// 				const blocksOfType = await db
		// 					.select()
		// 					.from(blocks)
		// 					.where(eq(blocks.category, blockDef.type));
		//
		// 				if (blocksOfType.length > 0) {
		// 					const randomBlock =
		// 						blocksOfType[Math.floor(Math.random() * blocksOfType.length)];
		// 					randomBlockId = randomBlock.id;
		// 					const blockData = await downloadAndUnzipBlock(randomBlock.archiveUrl);
		//
		// 					const [aiContent, tokens] = await generateAIContent(
		// 						prompt,
		// 						blockData.definition.variables,
		// 						blockDef.type,
		// 						country,
		// 						language,
		// 					);
		// 					return {
		// 						aiContent,
		// 						tokens,
		// 						blockData,
		// 					};
		// 				}
		// 			} catch (err) {
		// 				throw new Error(`Block generation with id - ${randomBlockId} was failed `);
		// 			}
		// 		});
		// 		const blockResults = await Promise.allSettled(blockPromises);
		// 		blockResults.forEach((result) => {
		// 			if (result.status === 'rejected') {
		// 				console.log(result.reason);
		// 				return;
		// 			}
		// 			const blockResult = result.value;
		// 			if (!blockResult) return;
		// 			const { aiContent, tokens, blockData } = blockResult;
		//
		// 			tokensInfo.totalPromptTokens += tokens.promptTokens;
		// 			tokensInfo.totalCompletionTokens += tokens.completionTokens;
		// 			tokensInfo.totalTokens += tokens.totalTokens;
		//
		// 			const themeVariables = aiContent.theme || {};
		// 			allThemeVariables = { ...allThemeVariables, ...themeVariables };
		//
		// 			const contentForHtml = { ...aiContent };
		// 			delete contentForHtml.theme;
		// 			delete contentForHtml.meta;
		//
		// 			const filledHtml = fillVariables(blockData.html, contentForHtml);
		// 			allHtml += filledHtml + '\n';
		//
		// 			const updatedCss = applyThemeToCss(blockData.css, themeVariables);
		// 			allStyles += updatedCss + '\n';
		//
		// 			metaTags = generateMetaTags(aiContent.meta);
		// 		});
		//
		// 		let finalStyles = '';
		// 		if (Object.keys(allThemeVariables).length > 0) {
		// 			finalStyles += ':root {\n';
		// 			Object.entries(allThemeVariables).forEach(([varName, value]) => {
		// 				finalStyles += `  ${varName}: ${value};\n`;
		// 			});
		// 			finalStyles += '}\n\n';
		// 		}
		// 		finalStyles += allStyles;
		//
		// 		const generatedSite = `<!DOCTYPE html>
		// <html lang="${language}">
		// <head>
		//   <meta charset="UTF-8">
		//   <meta name="viewport" content="width=device-width, initial-scale=1.0">
		//   ${metaTags}
		//   <style>
		//     * {
		//       margin: 0;
		//       padding: 0;
		//       box-sizing: border-box;
		//     }
		//     body {
		//       font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
		//     }
		//     ${finalStyles}
		//   </style>
		// </head>
		// <body>
		// ${allHtml}
		// </body>
		// </html>`;
		//
		// 		const zip = new AdmZip();
		// 		zip.addFile('index.html', Buffer.from(generatedSite, 'utf8'));
		//
		// 		const zipBuffer = zip.toBuffer();
		// 		const safeName = slugify(`site-${name}-${new Date().getTime()}.zip`, {
		// 			lower: true,
		// 			strict: true,
		// 		});
		//
		// 		const { error } = await supabase.storage.from('sites').upload(safeName, zipBuffer, {
		// 			contentType: 'application/zip',
		// 			upsert: false,
		// 		});
		//
		// 		if (error) {
		// 			throw error;
		// 		}
		//
		// 		const inputPrice = tokensInfo.totalPromptTokens * (PRICE_FOR_PROMPTS_OPENAI.input / 1000000);
		// 		const outputPrice = tokensInfo.totalCompletionTokens * (PRICE_FOR_PROMPTS_OPENAI.output / 1000000);
		//
		// 		const totalPrice = inputPrice + outputPrice;
		//
		// 		const { data: urlData } = supabase.storage.from('sites').getPublicUrl(safeName);
		//
		// 		const [siteData] = await db
		// 			.update(sites)
		// 			.set({
		// 				prompt,
		// 				archiveUrl: urlData.publicUrl,
		// 				totalTokens: tokensInfo.totalTokens,
		// 				completionTokens: tokensInfo.totalCompletionTokens,
		// 				promptTokens: tokensInfo.totalPromptTokens,
		// 				inputUsdPrice: cutNumber(inputPrice, 6),
		// 				outputUsdPrice: cutNumber(outputPrice, 6),
		// 				totalUsdPrice: cutNumber(totalPrice, 6),
		// 				updatedAt: new Date(),
		// 			})
		// 			.where(eq(sites.id, siteId))
		// 			.returning();
		//
		// 		return reply.send({
		// 			data: {
		// 				...siteData,
		// 				preview: generatedSite,
		// 			},
		// 			success: true,
		// 		});
	} catch (err) {
		reply.status(500).send({
			error: err.message,
			success: false,
		});
	}
};

export const regenerateBlock = async (request, reply) => {
	try {
		const { siteId, blockId } = request.params;
		const { regeneratingPagesPath, blockIndex } = request.body;

		const [result] = await db.select().from(sites).where(eq(sites.id, siteId));
		const {
			name,
			prompt,
			definition,
			country,
			language,
			archiveUrl,
			totalTokens: totalTokensDB,
			promptTokens: promptTokensDB,
			completionTokens: completionTokensDB,
		} = result;
		const template = await db.query.templates.findFirst({
			where: eq(templates.id, definition),
		});

		if (!template) {
			return reply.status(404).send({ error: 'Template not found' });
		}

		const tokensInfo = {
			totalPromptTokens: promptTokensDB,
			totalCompletionTokens: completionTokensDB,
			totalTokens: totalTokensDB,
		};
		let isGlobalBlock = false;
		const htmlPagesPath = await extractHtmlFiles(archiveUrl);
		const currentBlock = await getBlockById(blockId);
		const newBlock = await getBlockByType(currentBlock.category);
		let generatedBlock;

		if (
			template.definition.globals.blocks.some(
				(tmpBlock) => tmpBlock.type === newBlock.category,
			)
		) {
			const [preparedGlobalBlocks] = await prepareGlobalBlocks(
				[newBlock],
				template?.definition?.pages,
				prompt,
				country,
				language,
			);
			isGlobalBlock = true;

			tokensInfo.totalPromptTokens += preparedGlobalBlocks.tokens.promptTokens;
			tokensInfo.totalCompletionTokens += preparedGlobalBlocks.tokens.completionTokens;
			tokensInfo.totalTokens += preparedGlobalBlocks.tokens.totalTokens;

			generatedBlock = preparedGlobalBlocks;
		} else {
			const preparedBlock = await prepareBlock(newBlock, prompt, country, language);

			tokensInfo.totalPromptTokens += preparedBlock.tokens.promptTokens;
			tokensInfo.totalCompletionTokens += preparedBlock.tokens.completionTokens;
			tokensInfo.totalTokens += preparedBlock.tokens.totalTokens;

			generatedBlock = preparedBlock;
		}

		htmlPagesPath.forEach((p) => {
			if (isGlobalBlock || regeneratingPagesPath.includes(p.path)) {
				p.block = generatedBlock;
			}
		});
		const newHTML = updatePageContentRegex(
			htmlPagesPath,
			currentBlock.id,
			template.definition.pages,
			blockIndex,
		);

		const inputPrice =
			tokensInfo.totalPromptTokens * (PRICE_FOR_PROMPTS_OPENAI.input / 1000000);
		const outputPrice =
			tokensInfo.totalCompletionTokens * (PRICE_FOR_PROMPTS_OPENAI.output / 1000000);
		const totalPrice = inputPrice + outputPrice;

		const zip = new AdmZip();
		newHTML.forEach((page) => {
			zip.addFile(`${page.nameWithoutExtension}.html`, Buffer.from(page.html, 'utf8'));
		});
		const zipBuffer = zip.toBuffer();

		const safeName = slugify(`site-${name}-${new Date().getTime()}.zip`, {
			lower: true,
			strict: true,
		});

		const { error: uploadError } = await supabase.storage
			.from('sites')
			.upload(safeName, zipBuffer, {
				contentType: 'application/zip',
				upsert: false,
			});

		if (uploadError) {
			throw uploadError;
		}

		const { data: urlData } = supabase.storage.from('sites').getPublicUrl(safeName);

		const [siteData] = await db
			.update(sites)
			.set({
				archiveUrl: urlData.publicUrl,
				updatedAt: new Date(),
				promptTokens: tokensInfo.totalPromptTokens,
				completionTokens: tokensInfo.totalCompletionTokens,
				totalTokens: tokensInfo.totalTokens,
				inputUsdPrice: inputPrice,
				outputUsdPrice: outputPrice,
				totalUsdPrice: totalPrice,
			})
			.where(eq(sites.id, siteId))
			.returning();

		return reply.send({
			data: {
				...siteData,
				previews: newHTML.map((page) => page.html),
			},
			success: true,
		});
	} catch (err) {
		reply.status(500).send({
			error: err.message,
			success: false,
		});
	}
};
