import {createSite} from "./handlers.js";
import {
  createSiteSchema
} from "./schema.js";

const routes = async (fastify) => {

  fastify.post("/", {
    handler: createSite,
    schema: createSiteSchema,
  });
};

export default routes;
