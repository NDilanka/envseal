/**
 * Forbids passing a secret-carrying expression to a logging sink.
 *
 * The protocol's guarantee is that a value travels User -> prompter -> broker ->
 * sink and crosses no other boundary. A stray `console.log(value)` during
 * debugging silently adds a fifth destination — one that in an agent harness is
 * captured, persisted, and frequently shipped to a model provider. The type
 * system cannot catch it, because `SecretValue` is a `Buffer` and `console.log`
 * accepts anything.
 *
 * Heuristic by design: it matches identifiers and members whose name indicates
 * secret material. That will not catch a value laundered through an
 * indirection, and it is not meant to — it catches the debugging reflex, which
 * is how this class of leak actually happens.
 */

const LOG_SINKS = new Set(['log', 'info', 'warn', 'error', 'debug', 'trace', 'dir']);
const SECRET_NAMES =
  /^(secret|secretValue|value|rawValue|plaintext|apiKey|credential|token|password|passphrase)$/i;

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow passing secret-shaped values to console or a logger',
    },
    schema: [],
    messages: {
      noSecretToLog:
        'Do not log "{{name}}". A secret must not reach stdout, stderr, or a log file — ' +
        'in an agent harness those are captured and often sent to a model provider. ' +
        'Log the key name or a fingerprint instead.',
    },
  },

  create(context) {
    /** Does this expression look like it carries secret material? */
    function secretName(node) {
      if (node.type === 'Identifier' && SECRET_NAMES.test(node.name)) return node.name;
      if (node.type === 'MemberExpression' && node.property.type === 'Identifier') {
        if (SECRET_NAMES.test(node.property.name)) {
          const objectName =
            node.object.type === 'Identifier' ? `${node.object.name}.` : '';
          return `${objectName}${node.property.name}`;
        }
      }
      return null;
    }

    function isLogSink(callee) {
      if (callee.type !== 'MemberExpression' || callee.property.type !== 'Identifier') {
        return false;
      }
      if (!LOG_SINKS.has(callee.property.name)) return false;
      const obj = callee.object;
      if (obj.type === 'Identifier') {
        return obj.name === 'console' || /logger|log$/i.test(obj.name);
      }
      // process.stdout.write / process.stderr.write
      return false;
    }

    function isStdWrite(callee) {
      return (
        callee.type === 'MemberExpression' &&
        callee.property.type === 'Identifier' &&
        callee.property.name === 'write' &&
        callee.object.type === 'MemberExpression' &&
        callee.object.property.type === 'Identifier' &&
        (callee.object.property.name === 'stdout' || callee.object.property.name === 'stderr')
      );
    }

    return {
      CallExpression(node) {
        if (!isLogSink(node.callee) && !isStdWrite(node.callee)) return;
        for (const arg of node.arguments) {
          const name = secretName(arg);
          if (name !== null) {
            context.report({ node: arg, messageId: 'noSecretToLog', data: { name } });
            continue;
          }
          // Template literals: `key=${value}`
          if (arg.type === 'TemplateLiteral') {
            for (const expr of arg.expressions) {
              const exprName = secretName(expr);
              if (exprName !== null) {
                context.report({
                  node: expr,
                  messageId: 'noSecretToLog',
                  data: { name: exprName },
                });
              }
            }
          }
        }
      },
    };
  },
};
