export const getHealth = async (request, reply) => {
	try {
		return reply.code(200).send({
			status: "ok",
		});
	} catch (error) {
		reply.code(400).send({
			success: false,
			error: error.message,
		});
	}
};