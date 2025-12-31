export const createSiteSchema = {
  tags: ["Sites"],
  summary: "Create new site",
  description: "Create new site",
  body: {
    type: "object",
    required: ["templatesIds"],
    properties: {
      templatesIds: {
        type: "array",
        items: {
          type: "number"
        },
        minItems: 1,
        uniqueItems: true,
      },
      prompt: {
        type: "string",
        maxLength: 1000,
      },
    },
  },
};