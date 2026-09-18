// 一次性维护脚本：把某个工作区从「最近项目」永久移除。
//
// 关键点：removedProjects 是「墓碑」集合，服务端用
//   removedProjects.has(sessionCwd)
// 做精确字符串比较（见 pi-web-ui dist/server/agent-service.js 的 pushProjects）。
// 因此墓碑必须写成 Windows 原样路径（C:\Users\X\Desktop\test），
// 小写或正斜杠形式都匹配不上，会导致条目立刻复活。
const fs = require('fs');
const path = require('path');

const stateFile = process.argv[2] || path.join(process.env.USERPROFILE || process.env.HOME, '.pi-web', 'client-state.json');
const exact = process.argv[3] || path.join(process.env.USERPROFILE || process.env.HOME, 'Desktop', 'test'); // C:\Users\X\Desktop\test
const norm = (v) => String(v).replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
const target = norm(exact);

const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
// 全局删除名单：不依赖浏览器 clientId，能阻止旧 session 扫描自动复活。
// 用户之后主动重新打开该目录时，服务端会把它从名单移除并恢复到最近项目。
const GLOBAL_KEY = '__piweb_global__';
const globalState = (state[GLOBAL_KEY] ??= {});
const removedGlobal = new Set(globalState.removedProjects ?? []);
removedGlobal.add(exact);
globalState.removedProjects = [...removedGlobal];
// 清除旧版错误写入的永久字段；新规则由 removedProjects 管理。
delete globalState.permanentRemovedProjects;
const report = [];

for (const [key, value] of Object.entries(state)) {
	if (!value || typeof value !== 'object') continue;

	const before = (value.projects || []).length;
	if (Array.isArray(value.projects)) value.projects = value.projects.filter((x) => !x || norm(x.path) !== target);

	// 清掉任何"形式不对"的历史墓碑（小写/正斜杠），再写入精确路径
	const kept = (value.removedProjects || []).filter((p) => norm(p) !== target);
	if (kept.length !== (value.removedProjects || []).length || !kept.includes(exact)) {
		value.removedProjects = [...new Set([...kept, exact])];
	}

	if (value.lastCwd && norm(value.lastCwd) === target) {
		value.lastCwd = (value.projects || []).slice(-1)[0]?.path || value.lastCwd;
	}
	for (const field of ['projectModels', 'projectProviderKeys']) {
		if (value[field] && typeof value[field] === 'object') {
			for (const k of Object.keys(value[field])) if (norm(k) === target) delete value[field][k];
		}
	}
	const removedNow = before - (value.projects || []).length;
	if (removedNow > 0) report.push(`${key}: 移除 ${removedNow} 项`);
}

const tmp = stateFile + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
fs.renameSync(tmp, stateFile);

console.log(report.length ? report.join('\n') : 'projects 数组里本就没有该条目');
console.log('已写入全局删除名单（主动重新打开该目录时会恢复）: ' + exact);
