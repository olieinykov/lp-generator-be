import { getPrompt, postPrompt, putPrompt } from './handlers';
import { getPromptSchema, postPromptSchema, putPromptSchema } from './schema';

const routes = async (fastify) => {
	fastify.get('/:promptId', {
		handler: getPrompt,
		schema: getPromptSchema,
	});
	fastify.post('/', {
		handler: postPrompt,
		schema: postPromptSchema,
	});
	fastify.put('/:promptId', {
		handler: putPrompt,
		schema: putPromptSchema,
	});
};

export default routes;
