import assert from 'node:assert/strict'
import { loadProjectFiles, loadBundledProject } from '../src/player/packageLoader.js'

const manifest = { format: 'narrativesteward-project', version: 1, title: 'Test', files: {world:'world.json', events:'events.json', scenes:{end:'scenes/end.json'}}, assets: [] }
const world = { locations:[{id:'room', name:'Room'}] }
const events = { nodes:[{id:'end',title:'End',type:'ending'}],edges:[],state_variables:[] }
const scene = { event_id:'end',beats:[{id:'b',kind:'narration',content:'<script>plain text</script>',location:'room'}],edges:[] }
function files(change={}) {
  const data = {'manifest.json':manifest, 'world.json':world, 'events.json':events, 'scenes/end.json':scene, ...change}
  return Object.entries(data).filter(([,v])=>v!==null).map(([name,value])=>({ name:name.split('/').at(-1), webkitRelativePath:`project/${name}`,size:JSON.stringify(value).length,text:async()=>JSON.stringify(value) }))
}
const project = await loadProjectFiles(files())
assert.equal((await project.dataSource.getScene('', 'end')).content.beats[0].content, '<script>plain text</script>')
assert.equal(project.dataSource.assetUrl('', 'https://invalid.test/pixel'), '')
project.dispose()
await assert.rejects(loadProjectFiles(files({'manifest.json':{...manifest,version:42}})), /version/)
await assert.rejects(loadProjectFiles(files({'scenes/end.json':null})), /Missing file/)
await assert.rejects(loadProjectFiles(files({'events.json':{...events,edges:[{id:'e',source:'end',target:'absent'}]}})), /Invalid edge/)
await assert.rejects(loadProjectFiles(files({'world.json':{locations:[{id:'room',name:'Room',image:'https://invalid.test/pixel'}]}})), /Image not included/)
await assert.rejects(loadProjectFiles(files({'manifest.json':{...manifest,files:{...manifest.files,world:'../world.json'}}})), /Missing file/)
await assert.rejects(loadProjectFiles([...files(), ...files()]), /Duplicate/)
console.log('PASS: portable project loader, text handling, versions, references and path checks')

const bundle = { manifest, files: { 'manifest.json':manifest, 'world.json':world, 'events.json':events, 'scenes/end.json':scene } }
const bundled = await loadBundledProject(bundle, 'file:///export/player.html')
assert.deepEqual((await bundled.dataSource.getScene('', 'end')).content, scene)
await assert.rejects(loadBundledProject(null, 'file:///export/player.html'), /Missing story/)
await assert.rejects(loadBundledProject({...bundle, files:{...bundle.files, 'manifest.json':{...manifest,version:99}}}, 'file:///export/player.html'), /version/)

const { storyProgress, mergeExploration } = await import('../src/player/progress.js')
const graph = {nodes:[{id:'a',title:'A'},{id:'b',title:'Secret B'},{id:'c',title:'Secret C'}],edges:[{id:'ab',source:'a',target:'b',label:'Hidden branch'},{id:'ac',source:'a',target:'c'}]}
const first = [{kind:'beat',eventId:'a',eventTitle:'A',bgImage:'file:///a.png',beat:{id:'a1',content:'already read'}},{kind:'event_choice',label:'go B'}, {kind:'beat',eventId:'b',eventTitle:'B',bgImage:'file:///b.png',beat:{id:'b1',content:'read then SECRET'}}]
const empty = {events:{},edges:[]}
const discovered = mergeExploration(empty,first,[{kind:'event',edge_id:'ab'}],{0:12,2:4})
const progress = storyProgress(graph,discovered,'b')
assert.equal(progress.nodes.length,3)
assert.equal(progress.edges.length,2)
assert.deepEqual(progress.nodes.map(n=>n.locked),[false,false,true])
assert.equal(progress.nodes[1].rows[0].content,'read')
assert.equal(progress.nodes[0].rows[1].content,'go B')
assert.equal(progress.nodes[0].completed,true)
assert.equal(progress.nodes[1].completed,false)
assert.equal(progress.nodes[1].current,true)
assert.equal(progress.nodes[2].title,'???')
assert.equal(progress.nodes[2].image,'')
assert.ok(!JSON.stringify(progress).includes('SECRET'))
assert.ok(!JSON.stringify(progress).includes('Secret C'))
assert.ok(!JSON.stringify(progress).includes('Hidden branch'))
// Rewinding changes the current location without forgetting already explored B.
const undone = mergeExploration(discovered,first.slice(0,1),[],{0:12})
assert.equal(undone,discovered)
assert.deepEqual(storyProgress(graph,undone,'a').nodes.map(n=>n.locked),[false,false,true])
const other = [...first.slice(0,1),{kind:'event_choice',label:'go C'},{kind:'beat',eventId:'c',eventTitle:'C',bgImage:'file:///c.png',beat:{id:'c1',content:'another route'}}]
const combined = mergeExploration(undone,other,[{kind:'event',edge_id:'ac'}],{0:12,2:13},'c')
const mapped = storyProgress(graph,combined,'c')
assert.ok(mapped.nodes.every(n=>!n.locked))
assert.ok(mapped.edges.every(e=>e.explored))
assert.equal(mapped.nodes[2].completed,true)
assert.equal(mapped.nodes[1].image,'file:///b.png')
assert.equal(mapped.nodes[1].rows[0].content,'read')
assert.equal(mergeExploration(combined,[],[],{}),combined)
assert.equal(Object.keys(empty.events).length,0)
console.log('PASS: full map, locked metadata, read prefixes, cumulative branching exploration and restart retention')

// Exploration stays visible, while only the active route lights its edges.
const activeC = storyProgress(graph, combined, 'c', [{kind:'event',edge_id:'ac'}], ['a','c'])
assert.deepEqual(activeC.edges.map(e=>e.onRoute), [false,true])
assert.deepEqual(activeC.nodes.map(n=>n.onRoute), [true,false,true])
assert.equal(activeC.nodes[1].title, 'B')
assert.equal(activeC.nodes[1].image, 'file:///b.png')
const rootOnly = storyProgress(graph, combined, 'a', [], ['a'])
assert.ok(rootOnly.edges.every(e=>!e.onRoute))
assert.deepEqual(rootOnly.nodes.map(n=>n.onRoute), [true,false,false])
assert.ok(rootOnly.nodes.every(n=>!n.locked))
console.log('PASS: explored nodes stay revealed, active edges follow current route, root remains rewindable')
