#!/usr/bin/env node
/**
 * 让 pi-web-ui 插件在模型切换完成时立即感知当前选中模型。
 *
 * 1) getActiveConversation() 增加 activeModel（当前 session 的模型，非最后历史消息）；
 * 2) AgentService.setModel() 成功后立即通知插件刷新。
 *
 * 幂等，启动器会在服务启动前自动执行；源码版本不匹配时退出码 2，且不阻断服务。
 */
const fs = require("fs");
const path = require("path");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const target = locateWebUiFile("dist", "server", "agent-service.js");
const marker = "plugin-live-model-patch";
const conversationNeedle = `                isStreaming: target.session.isStreaming,\n                messages: this.messagesOf(target),`;
const conversationReplacement = `                isStreaming: target.session.isStreaming,\n                // ${marker}: 当前选择，不能用最后一条历史 assistant 消息代替。\n                activeModel: state.model\n                    ? { provider: state.model.provider ?? null, model: state.model.id ?? null }\n                    : null,\n                messages: this.messagesOf(target),`;
const setModelVariants = [
  {
    name: "0.90.x",
    needle: `            this.rememberProjectModel(modelId);\n        }\n        catch (err) {`,
    replacement: `            this.rememberProjectModel(modelId);\n            // ${marker}: 切换成功即通知插件，不等下一条 assistant 消息。\n            this.notifyConversationChanged();\n        }\n        catch (err) {`,
  },
  {
    name: "0.92.x",
    needle: `            this.rememberProjectModel(modelId);\n            // 换模型后按新模型的窗口重算软上限覆盖（按模型覆盖可能不同，issue #229）。\n            this.applyCompactionOverrides();\n        }\n        catch (err) {`,
    replacement: `            this.rememberProjectModel(modelId);\n            // 换模型后按新模型的窗口重算软上限覆盖（按模型覆盖可能不同，issue #229）。\n            this.applyCompactionOverrides();\n            // ${marker}: 切换成功即通知插件，不等下一条 assistant 消息。\n            this.notifyConversationChanged();\n        }\n        catch (err) {`,
  },
];

if (!target || !fs.existsSync(target)) {
  console.error(`target not found: ${target}`);
  process.exit(1);
}
let source = fs.readFileSync(target, "utf8");
if (source.includes(marker)) {
  console.log("live-model patch already exists");
  process.exit(0);
}
const matched = setModelVariants.filter((v) => source.split(v.needle).length - 1 === 1);
if (!source.includes(conversationNeedle) || matched.length !== 1) {
  console.error(`pi-web-ui source changed; live-model patch not applied (setModel variants: ${matched.length})`);
  process.exit(2);
}
const variant = matched[0];
source = source.replace(conversationNeedle, conversationReplacement).replace(variant.needle, variant.replacement);
fs.writeFileSync(target, source, "utf8");
console.log("live-model patch applied");
