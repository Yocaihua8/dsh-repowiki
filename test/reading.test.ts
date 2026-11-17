import test from 'node:test'
import assert from 'node:assert/strict'
import { validateReadingPlan, routePages, diagramZoom } from '../src/shared/reading.js'
import { validateOutline, plannerPrompt, pageWorkerPrompt } from '../src/host/prompts.js'
const pages = [{id:'group',title:'Group',kind:'group',bytes:0},{id:'intro',title:'Intro',kind:'page',bytes:100},{id:'deep',title:'Details',kind:'page',bytes:100}]
const readingPaths = {user:['intro'],developer:['intro','deep'],maintainer:['deep','intro']}
test('one Wiki shares pages across three ordered reading paths; legacy remains usable', () => {
 validateReadingPlan({pages,readingPaths}); validateReadingPlan({pages})
 assert.deepEqual(routePages(pages,readingPaths,'maintainer').map(p=>p.id), ['deep','intro'])
 assert.deepEqual(routePages(pages,undefined,'all').map(p=>p.id), ['intro','deep'])
 assert.deepEqual(routePages(pages,undefined,'user'), [])
})
test('reject unknown, group and duplicate route references and invalid related pages', () => {
 for (const user of [['missing'],['group'],['intro','intro']]) assert.throws(()=>validateReadingPlan({pages,readingPaths:{...readingPaths,user}}),/阅读路线/)
 assert.throws(()=>validateReadingPlan({pages:[...pages,{id:'other',title:'Other',relatedPageIds:['missing']}]}),/关联页面/)
 assert.throws(()=>validateReadingPlan({pages:[...pages,{id:'other',title:'Intro'}]}),/同级标题/)
})
test('outline validation preserves reading metadata and supports empty routes', () => {
 const plan=validateOutline({title:'Wiki',pages:[{id:'intro',title:'Intro',readerQuestion:'How?',scope:'Basics',relatedPageIds:[]}],readingPaths:{user:['intro'],developer:[],maintainer:[]}}, {maxPages:28})
 assert.equal(plan.pages[0]?.readerQuestion,'How?'); assert.deepEqual(plan.readingPaths?.user,['intro'])
 assert.match(plannerPrompt({language:'zh',mode:'generate',coverage:[],fileCount:100}).system,/一套共享 Wiki/)
 assert.doesNotMatch(plannerPrompt({language:'zh',mode:'generate',coverage:[],fileCount:100}).system,/至少 20 页|至少创建 3 个/)
})
test('diagram zoom clamps invalid and out-of-range inputs',()=> {
 assert.equal(diagramZoom(0),.5); assert.equal(diagramZoom(4),2); assert.equal(diagramZoom(NaN),1)
})

test('shared usage pages start with actions while technical pages retain their own organization', () => {
 const page = {id:'start', title:'Start', summary:'Run the project', relatedPaths:[], sections:['Options','Start']}
 const outline = {title:'Wiki', description:'Shared', pages:[page], readingPaths:{user:['start'],developer:['start'],maintainer:[]}}
 const scan = {tree:[], docs:[], excerpts:[], treeTruncated:false}
 const prompt = pageWorkerPrompt({scan,outline,page,language:'zh'})
 assert.match(prompt.system,/第一节必须直接给出可执行的最短操作步骤/)
 assert.match(prompt.system,/允许合并和调整顺序/)
 const technical = pageWorkerPrompt({scan,outline:{...outline,readingPaths:undefined},page,language:'zh'})
 assert.doesNotMatch(technical.system,/第一节必须直接给出可执行的最短操作步骤/)
})
