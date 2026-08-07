import { zodToJsonSchema } from 'zod-to-json-schema';
import { SEP_TOOL_NAMES, INPUT_SCHEMAS } from '@envseal/protocol';

export function generateOpenAPI(port: number): unknown {
  const paths: Record<string, unknown> = {};

  for (const toolName of SEP_TOOL_NAMES) {
    const schema = INPUT_SCHEMAS[toolName];
    const jsonSchema = zodToJsonSchema(schema);

    paths[`/v1/${toolName}`] = {
      post: {
        summary: `Call ${toolName}`,
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: jsonSchema,
            },
          },
        },
        responses: {
          200: {
            description: 'Success',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  additionalProperties: true,
                },
              },
            },
          },
          400: {
            description: 'Bad request',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: {
                      type: 'object',
                      properties: {
                        code: { type: 'string' },
                        userMessage: { type: 'string' },
                        retriable: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
          401: {
            description: 'Unauthorized',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    error: {
                      type: 'object',
                      properties: {
                        code: { type: 'string' },
                        userMessage: { type: 'string' },
                        retriable: { type: 'boolean' },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    };
  }

  return {
    openapi: '3.1.0',
    info: {
      title: 'envseal SEP/1',
      version: '1.0.0',
      description:
        'Secret Elicitation Protocol - secure credential collection for AI agents',
    },
    servers: [
      {
        url: `http://127.0.0.1:${port}`,
        description: 'Loopback server (127.0.0.1 only)',
      },
    ],
    paths,
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'custom',
        },
      },
    },
    security: [
      {
        bearerAuth: [],
      },
    ],
  };
}
