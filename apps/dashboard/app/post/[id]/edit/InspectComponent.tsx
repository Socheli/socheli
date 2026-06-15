import type { Scene } from "./lib";
import { COMPLEX_TYPES, INSPECTOR_RICH_TYPES, TERMINAL_KINDS, primaryText, setPrimaryText } from "./lib";
import { Slider, Toggle, Ico, LockedFieldset } from "./ui";
import { Preview } from "../Preview";

export function InspectComponent({
  inspect, inspectSceneData, inspectProps, dims,
  setInspect, setSel, patchInspect, patchInspectLine, deleteInspectLine, addInspectLine,
}: {
  inspect: number;
  inspectSceneData: Scene;
  inspectProps: any;
  dims: { width: number; height: number };
  setInspect: (i: number | null) => void;
  setSel: (i: number) => void;
  patchInspect: (p: Partial<Scene>) => void;
  patchInspectLine: (lineIndex: number, p: Record<string, string>) => void;
  deleteInspectLine: (lineIndex: number) => void;
  addInspectLine: () => void;
}) {
  return (
    <div className="inspect-shell" onClick={() => setInspect(null)}>
      <div className="inspect-modal" onClick={(e) => e.stopPropagation()}>
        <div className="inspect-head">
          <div>
            <div className="ctx-title">Component inspector</div>
            <div className="inspect-title">Scene {inspect + 1} / {inspectSceneData.type?.replace("_", " ")}</div>
          </div>
          <div className="tool-row">
            <button className="btn" onClick={() => setSel(inspect)}><Ico c="SE" />Select</button>
            <button className="btn" onClick={() => setInspect(null)}><Ico c="CL" />Close</button>
          </div>
        </div>
        <div className="inspect-grid">
          <div className="solo-preview">
            {inspectProps ? <Preview props={inspectProps} fill controls={false} width={dims.width} height={dims.height} /> : <div className="empty">No solo preview</div>}
          </div>
          <div className="inspect-fields">
            <LockedFieldset locked={!!inspectSceneData.locked}>
            <Slider label="Duration" value={inspectSceneData.durationSec || 2} min={2} max={14} step={0.5} onChange={(v: number) => patchInspect({ durationSec: v })} fmt={(v: number) => v.toFixed(1) + "s"} />
            <div className="fld"><label>Narration</label><textarea className="input" rows={2} value={inspectSceneData.say ?? ""} onChange={(e) => patchInspect({ say: e.target.value })} /></div>
            {inspectSceneData.type === "terminal" && (
              <>
                <div className="fld"><label>Path</label><input className="input" value={inspectSceneData.path ?? ""} onChange={(e) => patchInspect({ path: e.target.value })} /></div>
                <div className="fld"><label>Status</label><select className="input" value={inspectSceneData.status ?? "ok"} onChange={(e) => patchInspect({ status: e.target.value })}><option value="ok">ok</option><option value="error">error</option></select></div>
                <div className="fld">
                  <label>Terminal lines</label>
                  <div className="line-editor">
                    {(inspectSceneData.lines ?? []).map((ln: any, lineIndex: number) => (
                      <div key={lineIndex} className="line-row">
                        <select value={ln.kind} onChange={(e) => patchInspectLine(lineIndex, { kind: e.target.value })}>{TERMINAL_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}</select>
                        <input value={ln.text} onChange={(e) => patchInspectLine(lineIndex, { text: e.target.value })} />
                        <button onClick={() => deleteInspectLine(lineIndex)}>DL</button>
                      </div>
                    ))}
                  </div>
                  <button className="btn" onClick={addInspectLine}><Ico c="AD" />Add line</button>
                </div>
              </>
            )}
            {inspectSceneData.type === "code_block" && (
              <>
                <div className="fld"><label>Title</label><input className="input" value={inspectSceneData.title ?? ""} onChange={(e) => patchInspect({ title: e.target.value })} /></div>
                <div className="fld"><label>Language</label><input className="input" value={inspectSceneData.language ?? "ts"} onChange={(e) => patchInspect({ language: e.target.value })} /></div>
                <div className="fld"><label>Code</label><textarea className="input" rows={8} value={inspectSceneData.code ?? ""} onChange={(e) => patchInspect({ code: e.target.value })} /></div>
                <div className="fld"><label>Focus lines</label><input className="input" value={(inspectSceneData.focusLines ?? []).join(", ")} onChange={(e) => patchInspect({ focusLines: e.target.value.split(",").map((x) => parseInt(x.trim(), 10)).filter(Boolean) })} /></div>
              </>
            )}
            {inspectSceneData.type === "before_after" && (
              <>
                <div className="fld"><label>Caption</label><input className="input" value={inspectSceneData.caption ?? ""} onChange={(e) => patchInspect({ caption: e.target.value })} /></div>
                {(["left", "right"] as const).map((side) => (
                  <div className="subpanel" key={side}>
                    <label>{side}</label>
                    <input className="input" value={inspectSceneData[side]?.title ?? ""} onChange={(e) => patchInspect({ [side]: { ...inspectSceneData[side], title: e.target.value } })} />
                    <textarea className="input" rows={3} value={inspectSceneData[side]?.text ?? ""} onChange={(e) => patchInspect({ [side]: { ...inspectSceneData[side], text: e.target.value } })} />
                    <Toggle on={!!inspectSceneData[side]?.bad} onClick={() => patchInspect({ [side]: { ...inspectSceneData[side], bad: !inspectSceneData[side]?.bad } })} label="bad state" />
                  </div>
                ))}
              </>
            )}
            {inspectSceneData.type === "big_number" && (
              <>
                <div className="fld"><label>Value</label><input className="input" value={inspectSceneData.value ?? ""} onChange={(e) => patchInspect({ value: e.target.value })} /></div>
                <div className="fld"><label>Label</label><input className="input" value={inspectSceneData.label ?? ""} onChange={(e) => patchInspect({ label: e.target.value })} /></div>
              </>
            )}
            {inspectSceneData.type === "quote" && (
              <>
                <div className="fld"><label>Quote</label><textarea className="input" rows={4} value={inspectSceneData.text ?? ""} onChange={(e) => patchInspect({ text: e.target.value })} /></div>
                <div className="fld"><label>Author</label><input className="input" value={inspectSceneData.author ?? ""} onChange={(e) => patchInspect({ author: e.target.value })} /></div>
              </>
            )}
            {(inspectSceneData.type === "image_focus" || inspectSceneData.type === "map") && (
              <div className="fld"><label>Caption</label><input className="input" value={inspectSceneData.caption ?? ""} onChange={(e) => patchInspect({ caption: e.target.value })} /></div>
            )}
            {inspectSceneData.type === "map" && (
              <div className="fld">
                <label>Points</label>
                <div className="line-editor">
                  {(inspectSceneData.points ?? []).map((pt: any, ptIndex: number) => (
                    <div key={ptIndex} className="line-row lr2">
                      <input value={pt.label ?? ""} onChange={(e) => patchInspect({ points: inspectSceneData.points.map((p: any, j: number) => (j === ptIndex ? { ...p, label: e.target.value } : p)) })} />
                      <button onClick={() => patchInspect({ points: inspectSceneData.points.filter((_: any, j: number) => j !== ptIndex) })}>DL</button>
                    </div>
                  ))}
                </div>
                <button className="btn" disabled={(inspectSceneData.points ?? []).length >= 3} onClick={() => patchInspect({ points: [...(inspectSceneData.points ?? []), { label: "Point" }] })}><Ico c="AD" />Add point</button>
              </div>
            )}
            {inspectSceneData.type === "chart" && (
              <>
                <div className="fld"><label>Title</label><input className="input" value={inspectSceneData.title ?? ""} onChange={(e) => patchInspect({ title: e.target.value })} /></div>
                <div className="fld"><label>Unit</label><input className="input" value={inspectSceneData.unit ?? ""} onChange={(e) => patchInspect({ unit: e.target.value })} /></div>
                <div className="fld">
                  <label>Bars</label>
                  <div className="line-editor">
                    {(inspectSceneData.bars ?? []).map((bar: any, barIndex: number) => (
                      <div key={barIndex} className="line-row">
                        <input value={bar.label ?? ""} onChange={(e) => patchInspect({ bars: inspectSceneData.bars.map((b: any, j: number) => (j === barIndex ? { ...b, label: e.target.value } : b)) })} />
                        <input type="number" value={bar.value ?? 0} onChange={(e) => patchInspect({ bars: inspectSceneData.bars.map((b: any, j: number) => (j === barIndex ? { ...b, value: Number(e.target.value) } : b)) })} />
                        <button onClick={() => patchInspect({ bars: inspectSceneData.bars.filter((_: any, j: number) => j !== barIndex) })}>DL</button>
                      </div>
                    ))}
                  </div>
                  <button className="btn" disabled={(inspectSceneData.bars ?? []).length >= 5} onClick={() => patchInspect({ bars: [...(inspectSceneData.bars ?? []), { label: "New", value: 50 }] })}><Ico c="AD" />Add bar</button>
                </div>
              </>
            )}
            {inspectSceneData.type === "grid" && (
              <>
                <div className="fld">
                  <label>Layout</label>
                  <div className="tool-row">
                    {(["rows", "cols"] as const).map((l) => <button key={l} className={`tg${(inspectSceneData.layout ?? "rows") === l ? " tg-on" : ""}`} onClick={() => patchInspect({ layout: l })}>{l}</button>)}
                  </div>
                </div>
                {(inspectSceneData.cells ?? []).map((cell: any, cellIndex: number) => (
                  <div className="subpanel" key={cellIndex}>
                    <label style={{ display: "flex", justifyContent: "space-between" }}>cell {cellIndex + 1}{(inspectSceneData.cells ?? []).length > 2 && <button className="lnk-btn" onClick={() => patchInspect({ cells: inspectSceneData.cells.filter((_: any, j: number) => j !== cellIndex) })}>remove</button>}</label>
                    <input className="input" value={cell.title ?? ""} onChange={(e) => patchInspect({ cells: inspectSceneData.cells.map((c: any, j: number) => (j === cellIndex ? { ...c, title: e.target.value } : c)) })} />
                    <textarea className="input" rows={2} value={cell.text ?? ""} onChange={(e) => patchInspect({ cells: inspectSceneData.cells.map((c: any, j: number) => (j === cellIndex ? { ...c, text: e.target.value } : c)) })} />
                  </div>
                ))}
                <button className="btn" disabled={(inspectSceneData.cells ?? []).length >= 3} onClick={() => patchInspect({ cells: [...(inspectSceneData.cells ?? []), { title: "New", text: "" }] })}><Ico c="AD" />Add cell</button>
              </>
            )}
            {inspectSceneData.type === "diagram" && (
              <>
                <div className="fld">
                  <label>Direction</label>
                  <div className="tool-row">
                    {(["vertical", "horizontal"] as const).map((d) => <button key={d} className={`tg${(inspectSceneData.direction ?? "vertical") === d ? " tg-on" : ""}`} onClick={() => patchInspect({ direction: d })}>{d}</button>)}
                  </div>
                </div>
                <div className="fld">
                  <label>Nodes</label>
                  <div className="line-editor">
                    {(inspectSceneData.nodes ?? []).map((node: any, nodeIndex: number) => (
                      <div key={nodeIndex} className="line-row lr2">
                        <input value={node.label ?? ""} onChange={(e) => patchInspect({ nodes: inspectSceneData.nodes.map((n: any, j: number) => (j === nodeIndex ? { ...n, label: e.target.value } : n)) })} />
                        <button onClick={() => patchInspect({ nodes: inspectSceneData.nodes.filter((_: any, j: number) => j !== nodeIndex) })}>DL</button>
                      </div>
                    ))}
                  </div>
                  <button className="btn" disabled={(inspectSceneData.nodes ?? []).length >= 4} onClick={() => patchInspect({ nodes: [...(inspectSceneData.nodes ?? []), { label: "Node" }] })}><Ico c="AD" />Add node</button>
                </div>
              </>
            )}
            {inspectSceneData.type === "timeline" && (
              <div className="fld">
                <label>Events</label>
                <div className="line-editor">
                  {(inspectSceneData.events ?? []).map((ev: any, evIndex: number) => (
                    <div key={evIndex} className="line-row">
                      <input style={{ width: 80 }} placeholder="time" value={ev.time ?? ""} onChange={(e) => patchInspect({ events: inspectSceneData.events.map((x: any, j: number) => (j === evIndex ? { ...x, time: e.target.value } : x)) })} />
                      <input value={ev.label ?? ""} onChange={(e) => patchInspect({ events: inspectSceneData.events.map((x: any, j: number) => (j === evIndex ? { ...x, label: e.target.value } : x)) })} />
                      <button onClick={() => patchInspect({ events: inspectSceneData.events.filter((_: any, j: number) => j !== evIndex) })}>DL</button>
                    </div>
                  ))}
                </div>
                <button className="btn" disabled={(inspectSceneData.events ?? []).length >= 4} onClick={() => patchInspect({ events: [...(inspectSceneData.events ?? []), { time: "", label: "Event" }] })}><Ico c="AD" />Add event</button>
              </div>
            )}
            {!COMPLEX_TYPES.has(inspectSceneData.type) && !INSPECTOR_RICH_TYPES.has(inspectSceneData.type) && (
              <div className="fld"><label>On-screen text</label><textarea className="input" rows={4} value={primaryText(inspectSceneData)} onChange={(e) => patchInspect(setPrimaryText(inspectSceneData, e.target.value))} /></div>
            )}
            </LockedFieldset>
          </div>
        </div>
      </div>
    </div>
  );
}
