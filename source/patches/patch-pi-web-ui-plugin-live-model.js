#!/usr/bin/env node
/**
 * 让 pi-web-ui 插件在模型切换完成时立即感知当前选中模型。
 *
 * 只做一件事：AgentService.setModel() 成功后立即通知插件刷新
 * （0.99.0 的 host.models 仍只有 list()，没有变更事件）。
 *
 * 早期那半「往快照注入 activeModel」已**退役**：
 *   - 0.94.1 起快照本来就带 canonical `model` 字段；
 *   - 0.99.0 更是把它作为原生字段 `model: modelId` 直接给出（见 server/agent-service.js
 *     的 readConversationForPlugins 返回值），插件侧 pickModel() 也优先读 `conv.model`。
 *   再注入一个同义字段只会造重复键，见 docs/升级适配/pi-web-ui-升级适配记录.md。
 *
 * 幂等，启动器会在服务启动前自动执行；源码版本不匹配时退出码 2，且不阻断服务。
 */
const fs = require("fs");
const { locateWebUiFile } = require("../scripts/pi-web-ui-locate.js");

const target = locateWebUiFile("dist", "server", "agent-service.js");
const marker = "plugin-live-model-patch";
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
if (matched.length !== 1) {
  console.error(`pi-web-ui source changed; live-model patch not applied (setModel variants: ${matched.length})`);
  process.exit(2);
}
source = source.replace(matched[0].needle, matched[0].replacement);
fs.writeFileSync(target, source, "utf8");
console.log(`live-model patch applied (variant ${matched[0].name})`);
