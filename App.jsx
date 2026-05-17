import { useState, useCallback, useRef, useEffect } from "react";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, Cell } from "recharts";
import { supabase } from "./supabase";

const N_COLORS = { 1:"#4A9EFF", 2:"#34C98A", 3:"#F5A623", 4:"#E8515A" };
const S_COLORS = { 0:"#7B9CFF", 1:"#F5A623", 2:"#E8515A", null:"#555" };
const S_LABELS = { 0:"S=0 集中", 1:"S=1 相鄰", 2:"S=2 分散" };
const THRESH_STD = 0.08;
const THRESH_DEV = 0.12;

function parseTxt(text) {
  const lines = text.trim().split("\n").filter(l => l.trim() && !l.includes("質量") && !l.includes("t\t"));
  const rows = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 5) {
      const t = parseFloat(parts[0]), vx = parseFloat(parts[3]), vy = parseFloat(parts[4]);
      if (!isNaN(t) && !isNaN(vx) && !isNaN(vy)) rows.push({ t, vx, vy });
    }
  }
  return rows;
}

function calcNorm(rows) {
  const rising = rows.filter(r => r.vy > 0);
  if (rising.length < 2) return null;
  const r0 = rising[0], rf = rising[rising.length - 1];
  const avx0 = Math.abs(r0.vx), avxf = Math.abs(rf.vx);
  const dt = rf.t - r0.t;
  if (dt === 0) return null;
  return { norm: (avx0 - avxf) / dt / avx0, vx0: avx0, vxf: avxf, dt, risingCount: rising.length };
}

function autoCheck(rows, vx0, risingCount, allData) {
  const warnings = [];
  if (risingCount < 4) warnings.push("上升段短");
  if (allData.length > 1) {
    const avg = allData.reduce((a,b)=>a+b.vx0,0)/allData.length;
    if (vx0 > avg * 1.3) warnings.push("初速離群高");
    if (vx0 < avg * 0.6) warnings.push("初速過低");
  }
  const vyRound = rows.filter(r=>!isNaN(r.vy)&&r.vy===Math.round(r.vy)&&r.vy%15===0).length;
  if (vyRound/rows.length > 0.4) warnings.push("疑似補點");
  const diffs = [];
  for (let i=1;i<rows.length;i++) diffs.push(rows[i].vx-rows[i-1].vx);
  if (diffs.length >= 3) {
    const m = diffs.reduce((a,b)=>a+b,0)/diffs.length;
    const std = Math.sqrt(diffs.reduce((a,b)=>a+(b-m)**2,0)/diffs.length);
    if (std < Math.abs(m)*0.05) warnings.push("vx逐差過規律");
  }
  const spd = rows.map(r=>Math.sqrt(r.vx**2+r.vy**2));
  for (let i=1;i<spd.length-1;i++) {
    const loc = (spd[i-1]+spd[i+1])/2;
    if (Math.abs(spd[i]-loc)>loc*0.3) { warnings.push("速度突跳"); break; }
  }
  const td = [];
  for (let i=1;i<rows.length;i++) td.push(rows[i].t-rows[i-1].t);
  if (td.length>0) {
    const tm = td.reduce((a,b)=>a+b,0)/td.length;
    const ts = Math.sqrt(td.reduce((a,b)=>a+(b-tm)**2,0)/td.length);
    if (ts>0.002) warnings.push("t間隔不規律");
  }
  const vy = rows.map(r=>r.vy);
  for (let i=1;i<vy.length-1;i++) {
    if (vy[i]<vy[i-1]-0.5&&vy[i+1]>vy[i]+0.5&&vy[i]>0) { warnings.push("vy異常回升"); break; }
  }
  return warnings.length>0 ? "⚠️ "+warnings.join("、") : "✓";
}

function parseFilename(filename) {
  const base = filename.replace(".txt","");
  const mN = base.match(/N(\d+)/), mS = base.match(/S(\d+)/);
  return { N: mN ? parseInt(mN[1]) : null, S: mS ? parseInt(mS[1]) : null };
}

function getType(name) { return name.match(/^(N\d+(?:S\d)?)/)?.[1] ?? name; }

function stats(vals) {
  if (!vals.length) return { avg: null, std: null, n: 0 };
  const avg = vals.reduce((a,b)=>a+b,0)/vals.length;
  const std = vals.length > 1 ? Math.sqrt(vals.reduce((a,b)=>a+(b-avg)**2,0)/(vals.length-1)) : 0;
  return { avg, std, n: vals.length };
}

function fmt(v, d=4) { return v==null ? "—" : v.toFixed(d); }

export default function App() {
  const [data, setData] = useState([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState("chart");
  const [dragging, setDragging] = useState(false);
  const [impactHistory, setImpactHistory] = useState([]);
  const [impactIdx, setImpactIdx] = useState(null);
  const [selectedType, setSelectedType] = useState(null);
  const [toast, setToast] = useState(null);
  const fileRef = useRef();

  // load from supabase on mount
  useEffect(() => {
    supabase.from("shuttlecock").select("*").order("created_at").then(({ data: rows, error }) => {
      if (error) { showToast("載入失敗：" + error.message, false); }
      else { setData(rows.map(dbToEntry)); }
      setLoading(false);
    });
  }, []);

  function dbToEntry(row) {
    return {
      name: row.name, N: row.n, S: row.s, norm: parseFloat(row.norm),
      vx0: parseFloat(row.vx0), vxf: parseFloat(row.vxf),
      dt: parseFloat(row.dt), risingCount: row.rising_count, status: row.status
    };
  }

  const showToast = (msg, ok=true) => {
    setToast({msg,ok});
    setTimeout(()=>setToast(null), 5000);
  };

  const processFile = useCallback((file) => {
    const { N, S } = parseFilename(file.name);
    if (N === null) { showToast(`${file.name}：無法解析 N 值`, false); return; }
    const reader = new FileReader();
    reader.onload = async e => {
      const rows = parseTxt(e.target.result);
      const calc = calcNorm(rows);
      if (!calc) { showToast(`${file.name}：上升段資料不足`, false); return; }
      const name = file.name.replace(".txt","");

      setData(prev => {
        if (prev.find(d => d.name === name)) { showToast("已存在，略過", false); return prev; }

        const entry = { name, N, S, ...calc, status: autoCheck(rows, calc.vx0, calc.risingCount, prev) };

        // calc impact
        const type = getType(name);
        const typeVals = prev.filter(d=>getType(d.name)===type).map(d=>d.norm);
        const sVals = S !== null ? prev.filter(d=>d.S===S).map(d=>d.norm) : [];
        const typeBefore = stats(typeVals), typeAfter = stats([...typeVals, entry.norm]);
        const sBefore = stats(sVals), sAfter = stats([...sVals, entry.norm]);
        const impact = { name, norm: entry.norm, type, S, typeBefore, typeAfter, sBefore, sAfter,
          typeIsFirst: typeVals.length===0,
          deviation: typeBefore.avg!=null ? entry.norm-typeBefore.avg : null,
          hasWarn: entry.status.includes("⚠️") };
        setImpactHistory(h => { const next=[...h,impact]; setImpactIdx(next.length-1); return next; });

        // save to supabase
        supabase.from("shuttlecock").insert({
          name, n: N, s: S, norm: entry.norm, vx0: entry.vx0, vxf: entry.vxf,
          dt: entry.dt, rising_count: entry.risingCount, status: entry.status
        }).then(({ error }) => {
          if (error) showToast("儲存失敗：" + error.message, false);
          else showToast(`已新增 ${name}${entry.status.includes("⚠️")?" ⚠":" ✓"}`, !entry.status.includes("⚠️"));
        });

        return [...prev, entry];
      });
    };
    reader.readAsText(file);
  }, []);

  const onDrop = useCallback(e => {
    e.preventDefault(); setDragging(false);
    [...e.dataTransfer.files].forEach(f => { if (f.name.endsWith(".txt")) processFile(f); });
  }, [processFile]);

  const onFileChange = e => [...e.target.files].forEach(processFile);

  const chartData = [...data].sort((a,b)=>a.norm-b.norm);
  const groupByS = [0,1,2].map(s => { const vals=data.filter(d=>d.S===s).map(d=>d.norm); return {s,...stats(vals)}; });
  const groupByN = [1,2,3,4].map(n => { const vals=data.filter(d=>d.N===n).map(d=>d.norm); return {n,...stats(vals)}; });
  const typeAvgMap = {};
  data.forEach(d => { const t=getType(d.name); if(!typeAvgMap[t]) typeAvgMap[t]=[]; typeAvgMap[t].push(d.norm); });
  Object.keys(typeAvgMap).forEach(t => { const v=typeAvgMap[t]; typeAvgMap[t]=v.reduce((a,b)=>a+b,0)/v.length; });

  if (loading) return (
    <div style={{fontFamily:"'DM Mono',monospace",background:"#0e0e11",minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",color:"#555",fontSize:13}}>
      載入資料中...
    </div>
  );

  return (
    <div style={{fontFamily:"'DM Mono',monospace",background:"#0e0e11",minHeight:"100vh",color:"#e8e6e0",padding:0}}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@300;400;500&family=Syne:wght@700;800&display=swap');
        *{box-sizing:border-box;margin:0;padding:0;}
        ::-webkit-scrollbar{width:4px}::-webkit-scrollbar-track{background:#1a1a1f}::-webkit-scrollbar-thumb{background:#333;border-radius:2px}
        .tab{background:none;border:none;color:#666;font-family:inherit;font-size:13px;padding:8px 16px;cursor:pointer;border-bottom:2px solid transparent;transition:all .2s;letter-spacing:.05em}
        .tab.active{color:#e8e6e0;border-bottom-color:#4A9EFF}
        .tab:hover{color:#aaa}
        .drop-zone{border:1.5px dashed #333;border-radius:8px;padding:32px;text-align:center;cursor:pointer;transition:all .2s}
        .drop-zone:hover,.drop-zone.drag{border-color:#4A9EFF;background:#4A9EFF0d}
        .data-table{width:100%;border-collapse:collapse;font-size:12px}
        .data-table th{text-align:left;padding:8px 12px;font-size:11px;color:#555;font-weight:400;letter-spacing:.06em;border-bottom:0.5px solid #2a2a32}
        .data-table td{padding:9px 12px;border-bottom:0.5px solid #1e1e24;font-variant-numeric:tabular-nums}
        .data-table tr:hover td{background:#ffffff06}
        .impact-box{background:#141418;border:0.5px solid #2a2a32;border-radius:8px;padding:16px;margin-bottom:20px}
        .impact-row{display:flex;justify-content:space-between;align-items:center;padding:5px 0;border-bottom:0.5px solid #1e1e241a;font-size:12px}
      `}</style>

      <div style={{padding:"28px 28px 0",borderBottom:"0.5px solid #1e1e24"}}>
        <div style={{display:"flex",alignItems:"baseline",gap:12,marginBottom:4}}>
          <span style={{fontFamily:"Syne",fontSize:22,fontWeight:800,letterSpacing:"-.02em"}}>羽球分球分析</span>
          <span style={{fontSize:11,color:"#555",letterSpacing:".1em"}}>SHUTTLECOCK RESEARCH</span>
        </div>
        <div style={{fontSize:11,color:"#555",marginBottom:16}}>{data.length} 組資料 ／ 指標：上升段水平減速率（無因次）</div>
        <div style={{display:"flex",gap:0,overflowX:"auto"}}>
          {[["chart","圖表"],["detail","各球"],["table","資料"],["coverage","完整度"],["upload","上傳"]].map(([id,label])=>(
            <button key={id} className={`tab${tab===id?" active":""}`} onClick={()=>setTab(id)}>{label}</button>
          ))}
        </div>
      </div>

      <div style={{padding:"24px 28px"}}>

        {/* CHART */}
        {tab==="chart" && (
          <div>
            <div style={{fontSize:11,color:"#555",marginBottom:20}}>指標值越高 → 水平減速越快 → 阻力特性越異常</div>
            <div style={{marginBottom:32}}>
              <div style={{fontSize:11,color:"#777",marginBottom:10}}>各組衰減率（依大小排序，顏色依 S）</div>
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={chartData} margin={{left:-10,right:10}}>
                  <XAxis dataKey="name" tick={{fontSize:9,fill:"#555"}} angle={-35} textAnchor="end" height={55}/>
                  <YAxis tick={{fontSize:10,fill:"#555"}}/>
                  <Tooltip contentStyle={{background:"#1a1a1f",border:"0.5px solid #333",borderRadius:6,fontSize:11}}
                    formatter={(v,n,p)=>[`${v.toFixed(4)}${chartData[p.index]?.status?.includes("⚠️")?" ⚠":""}`, "衰減率"]}
                    labelStyle={{color:"#aaa"}}/>
                  <ReferenceLine y={data.length?data.reduce((a,b)=>a+b.norm,0)/data.length:0} stroke="#4A9EFF" strokeDasharray="4 3" strokeOpacity={0.5}/>
                  <Bar dataKey="norm" radius={[3,3,0,0]}>
                    {chartData.map((e,i)=><Cell key={i} fill={e.S!==null?S_COLORS[e.S]:"#555"}/>)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
              <div style={{display:"flex",gap:16,marginTop:8,flexWrap:"wrap"}}>
                {[0,1,2].map(s=>(
                  <div key={s} style={{display:"flex",alignItems:"center",gap:5,fontSize:11,color:"#666"}}>
                    <div style={{width:10,height:10,borderRadius:2,background:S_COLORS[s]}}/>
                    {S_LABELS[s]}
                  </div>
                ))}
                <div style={{fontSize:11,color:"#555"}}>■ 灰 = N1（無S）</div>
                <div style={{fontSize:11,color:"#4A9EFF88"}}>— 平均</div>
              </div>
            </div>
            <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:20}}>
              <div>
                <div style={{fontSize:11,color:"#777",marginBottom:10}}>依 S 分組（平均 ± 標準差）</div>
                {groupByS.filter(g=>g.avg!=null).map(g=>(
                  <div key={g.s} style={{marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#aaa",marginBottom:3}}>
                      <span>{S_LABELS[g.s]} <span style={{color:"#555"}}>({g.n}組)</span></span>
                      <span style={{color:S_COLORS[g.s]}}>{fmt(g.avg)} <span style={{color:"#555",fontSize:10}}>±{fmt(g.std,3)}</span></span>
                    </div>
                    <div style={{height:5,background:"#1e1e24",borderRadius:3,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${((g.avg-1.4)/(2.6-1.4))*100}%`,background:S_COLORS[g.s],borderRadius:3}}/>
                    </div>
                  </div>
                ))}
              </div>
              <div>
                <div style={{fontSize:11,color:"#777",marginBottom:10}}>依 N 分組（平均 ± 標準差）</div>
                {groupByN.filter(g=>g.avg!=null).map(g=>(
                  <div key={g.n} style={{marginBottom:10}}>
                    <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#aaa",marginBottom:3}}>
                      <span>N={g.n} <span style={{color:"#555"}}>({g.n}組)</span></span>
                      <span style={{color:N_COLORS[g.n]}}>{fmt(g.avg)} <span style={{color:"#555",fontSize:10}}>±{fmt(g.std,3)}</span></span>
                    </div>
                    <div style={{height:5,background:"#1e1e24",borderRadius:3,overflow:"hidden"}}>
                      <div style={{height:"100%",width:`${((g.avg-1.4)/(2.6-1.4))*100}%`,background:N_COLORS[g.n],borderRadius:3}}/>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* DETAIL */}
        {tab==="detail" && (()=>{
          const typeList = [...new Set(data.map(d=>getType(d.name)))].sort();
          const activeType = selectedType && typeList.includes(selectedType) ? selectedType : typeList[0];
          const typeData = data.filter(d=>getType(d.name)===activeType);
          const balls = {};
          typeData.forEach(d=>{
            const parts=d.name.split("-"), ballNum=parts[1]??"?";
            if(!balls[ballNum]) balls[ballNum]=[];
            balls[ballNum].push(d);
          });
          const ballKeys = Object.keys(balls).sort();
          const BALL_COLORS = ["#4A9EFF","#34C98A","#F5A623","#E8515A","#B07FFF"];
          const typeNorms = typeData.map(d=>d.norm);
          const typeAvg = typeNorms.length ? typeNorms.reduce((a,b)=>a+b,0)/typeNorms.length : null;
          const typeStd = typeNorms.length>1 ? Math.sqrt(typeNorms.reduce((a,b)=>a+(b-typeAvg)**2,0)/(typeNorms.length-1)) : 0;
          const allPoints = typeData.map(d=>{
            const parts=d.name.split("-"), ballNum=parts[1]??"?", expNum=parseInt(parts[2]??1);
            const ballIdx=ballKeys.indexOf(ballNum);
            const dev=typeAvg!=null?d.norm-typeAvg:0;
            return {x:ballIdx+(expNum-1)*0.15,y:d.norm,name:d.name,ballNum,expNum,ballIdx,
              color:BALL_COLORS[ballIdx%BALL_COLORS.length],isOutlier:Math.abs(dev)>THRESH_DEV,status:d.status};
          });
          const yMin=Math.min(...typeNorms,typeAvg??0)-0.15, yMax=Math.max(...typeNorms,typeAvg??0)+0.15;
          return (
            <div>
              <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:20}}>
                {typeList.map(t=>(
                  <button key={t} onClick={()=>setSelectedType(t)}
                    style={{background:t===activeType?"#1e2a3a":"none",border:`0.5px solid ${t===activeType?"#4A9EFF":"#2a2a32"}`,
                      borderRadius:4,color:t===activeType?"#4A9EFF":"#555",padding:"4px 12px",
                      cursor:"pointer",fontFamily:"inherit",fontSize:12}}>
                    {t}
                  </button>
                ))}
              </div>
              <div style={{display:"flex",gap:16,marginBottom:16,flexWrap:"wrap"}}>
                <div style={{fontSize:11,color:"#555"}}>平均 <span style={{color:"#e8e6e0"}}>{fmt(typeAvg)}</span></div>
                <div style={{fontSize:11,color:"#555"}}>標準差 <span style={{color:typeStd>THRESH_STD?"#E8515A":"#e8e6e0"}}>{fmt(typeStd,4)}{typeStd>THRESH_STD?" ⚠":""}</span></div>
                <div style={{fontSize:11,color:"#555"}}>{typeData.length} 筆 / {ballKeys.length} 顆球</div>
              </div>
              {(()=>{
                const W=500,H=200,PL=45,PR=20,PT=20,PB=30,cW=W-PL-PR,cH=H-PT-PB;
                const xScale=i=>PL+(ballKeys.length<=1?cW/2:(i/(ballKeys.length-1+0.3))*cW);
                const yScale=v=>PT+cH-((v-yMin)/(yMax-yMin))*cH;
                const avgY=typeAvg!=null?yScale(typeAvg):null;
                const hiY=typeAvg!=null?yScale(typeAvg+THRESH_DEV):null;
                const loY=typeAvg!=null?yScale(typeAvg-THRESH_DEV):null;
                return (
                  <svg viewBox={`0 0 ${W} ${H}`} style={{width:"100%",maxWidth:560,display:"block",marginBottom:20}}>
                    {[yMin,(yMin+yMax)/2,yMax].map((v,i)=>(
                      <g key={i}>
                        <line x1={PL} x2={W-PR} y1={yScale(v)} y2={yScale(v)} stroke="#1e1e24" strokeWidth="1"/>
                        <text x={PL-4} y={yScale(v)+4} textAnchor="end" fontSize="9" fill="#444">{v.toFixed(2)}</text>
                      </g>
                    ))}
                    {hiY&&loY&&<rect x={PL} y={hiY} width={cW} height={loY-hiY} fill="#4A9EFF08"/>}
                    {avgY&&<line x1={PL} x2={W-PR} y1={avgY} y2={avgY} stroke="#4A9EFF" strokeWidth="1" strokeDasharray="4 3" opacity="0.6"/>}
                    {avgY&&<text x={W-PR+3} y={avgY+4} fontSize="9" fill="#4A9EFF88">avg</text>}
                    {hiY&&<line x1={PL} x2={W-PR} y1={hiY} y2={hiY} stroke="#E8515A" strokeWidth="0.5" strokeDasharray="3 3" opacity="0.4"/>}
                    {loY&&<line x1={PL} x2={W-PR} y1={loY} y2={loY} stroke="#E8515A" strokeWidth="0.5" strokeDasharray="3 3" opacity="0.4"/>}
                    {ballKeys.map((b,i)=>(
                      <text key={b} x={xScale(i)} y={H-PT+14} textAnchor="middle" fontSize="10" fill="#555">球{b}</text>
                    ))}
                    {allPoints.map((p,i)=>{
                      const cx=xScale(p.ballIdx)+(p.expNum-1)*18, cy=yScale(p.y);
                      return (
                        <g key={i}>
                          <circle cx={cx} cy={cy} r={6} fill={p.color} fillOpacity={0.25} stroke={p.isOutlier?"#E8515A":p.color} strokeWidth={p.isOutlier?1.5:1}/>
                          {p.isOutlier&&<text x={cx} y={cy-10} textAnchor="middle" fontSize="10" fill="#E8515A">⚠</text>}
                          <title>{p.name}</title>
                          <circle cx={cx} cy={cy} r={10} fill="transparent"/>
                        </g>
                      );
                    })}
                  </svg>
                );
              })()}
              <div style={{display:"flex",gap:16,flexWrap:"wrap",marginBottom:16}}>
                {ballKeys.map((b,i)=>(
                  <div key={b} style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:"#666"}}>
                    <div style={{width:10,height:10,borderRadius:"50%",background:BALL_COLORS[i%BALL_COLORS.length],opacity:0.8}}/>
                    球{b}
                  </div>
                ))}
              </div>
              {allPoints.map(p=>(
                <div key={p.name} style={{display:"flex",gap:12,padding:"5px 0",borderBottom:"0.5px solid #1e1e24",alignItems:"center",fontSize:11}}>
                  <div style={{width:8,height:8,borderRadius:"50%",background:p.color,flexShrink:0}}/>
                  <span style={{color:"#aaa",width:130}}>{p.name}</span>
                  <span style={{color:"#e8e6e0",width:60}}>{p.y.toFixed(4)}</span>
                  {p.isOutlier&&<span style={{color:"#E8515A",fontSize:10}}>⚠ 離群</span>}
                  {p.status.includes("⚠️")&&<span style={{color:"#F5A623",fontSize:10}}>{p.status.replace("⚠️ ","")}</span>}
                </div>
              ))}
            </div>
          );
        })()}

        {/* TABLE */}
        {tab==="table" && (
          <div style={{overflowX:"auto"}}>
            <table className="data-table">
              <thead><tr>
                <th>名稱</th><th>N</th><th>S</th><th>初速</th><th>末速</th><th>時長(s)</th><th>衰減率</th><th>均差</th><th>狀態</th>
              </tr></thead>
              <tbody>
                {[...data].sort((a,b)=>a.N-b.N||(a.S??-1)-(b.S??-1)).map(d=>{
                  const typeAvg=typeAvgMap[getType(d.name)], dev=typeAvg!=null?d.norm-typeAvg:null;
                  return (
                    <tr key={d.name}>
                      <td style={{color:"#ccc"}}>{d.name}</td>
                      <td style={{color:N_COLORS[d.N]}}>{d.N}</td>
                      <td style={{color:d.S!==null?S_COLORS[d.S]:"#555"}}>{d.S??'—'}</td>
                      <td style={{color:"#aaa"}}>{d.vx0.toFixed(0)}</td>
                      <td style={{color:"#aaa"}}>{d.vxf.toFixed(0)}</td>
                      <td style={{color:"#aaa"}}>{d.dt.toFixed(3)}</td>
                      <td style={{color:"#e8e6e0"}}>{d.norm.toFixed(4)}</td>
                      <td style={{color:dev==null?"#555":Math.abs(dev)>THRESH_DEV?"#E8515A":Math.abs(dev)<0.001?"#555":dev>0?"#e8a87c":"#7cbce8"}}>
                        {dev==null?"—":(dev>0?"+":dev<0?"-":"±")+Math.abs(dev).toFixed(4)}{dev!=null&&Math.abs(dev)>THRESH_DEV?" ⚠":""}
                      </td>
                      <td style={{color:d.status.includes("⚠️")?"#F5A623":"#555",fontSize:10}}>{d.status}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {/* COVERAGE */}
        {tab==="coverage" && (
          <div>
            <div style={{fontSize:11,color:"#555",marginBottom:20}}>依型態分組——<span style={{color:"#aaa"}}>N2S1-球編號-實驗次數</span></div>
            {(()=>{
              const types={};
              data.forEach(d=>{
                const type=getType(d.name), parts=d.name.split("-");
                const ballNum=parts[1]??"?", expNum=parts[2]??"?";
                if(!types[type]) types[type]={};
                if(!types[type][ballNum]) types[type][ballNum]=[];
                types[type][ballNum].push({name:d.name,expNum,status:d.status});
              });
              return Object.entries(types).sort(([a],[b])=>a.localeCompare(b)).map(([type,balls])=>(
                <div key={type} style={{padding:"12px 14px",borderBottom:"0.5px solid #1e1e24"}}>
                  <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:8}}>
                    <span style={{fontSize:13,color:"#ccc",width:80}}>{type}</span>
                    <span style={{fontSize:11,color:"#555"}}>{Object.keys(balls).length} 顆球</span>
                  </div>
                  {Object.entries(balls).sort(([a],[b])=>a.localeCompare(b)).map(([ballNum,exps])=>(
                    <div key={ballNum} style={{paddingLeft:12,marginBottom:6}}>
                      <div style={{fontSize:11,color:"#888",marginBottom:3}}>球 {ballNum}　<span style={{color:"#555"}}>（{exps.length} 次）</span></div>
                      {exps.map(ex=>(
                        <div key={ex.name} style={{fontSize:11,paddingLeft:12,color:"#555",marginBottom:2}}>
                          第 {ex.expNum} 次：{ex.name}{ex.status.includes("⚠️")&&<span style={{color:"#F5A623",marginLeft:6}}>⚠</span>}
                        </div>
                      ))}
                    </div>
                  ))}
                </div>
              ));
            })()}
          </div>
        )}

        {/* UPLOAD */}
        {tab==="upload" && (
          <div>
            {impactHistory.length>0&&(()=>{
              const idx=impactIdx??impactHistory.length-1;
              const {name,norm,type,S,typeBefore,typeAfter,sBefore,sAfter,typeIsFirst,deviation,hasWarn}=impactHistory[idx];
              const dc=(d)=>d==null?"#555":d>0.0005?"#E8515A":d<-0.0005?"#34C98A":"#555";
              const ds=(d)=>d==null?"—":(d>=0?"+":"")+d.toFixed(4);
              return (
                <div className="impact-box">
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                    <span style={{fontSize:11,color:"#777"}}>上傳紀錄 {idx+1}/{impactHistory.length}　{name}　{norm.toFixed(4)}{hasWarn?" ⚠":""}</span>
                    <div style={{display:"flex",gap:6}}>
                      <button onClick={()=>setImpactIdx(Math.max(0,idx-1))} disabled={idx===0}
                        style={{background:"none",border:"0.5px solid #2a2a32",borderRadius:4,color:idx===0?"#333":"#aaa",padding:"2px 10px",cursor:idx===0?"default":"pointer",fontFamily:"inherit",fontSize:12}}>←</button>
                      <button onClick={()=>setImpactIdx(Math.min(impactHistory.length-1,idx+1))} disabled={idx===impactHistory.length-1}
                        style={{background:"none",border:"0.5px solid #2a2a32",borderRadius:4,color:idx===impactHistory.length-1?"#333":"#aaa",padding:"2px 10px",cursor:idx===impactHistory.length-1?"default":"pointer",fontFamily:"inherit",fontSize:12}}>→</button>
                    </div>
                  </div>
                  <div style={{marginBottom:12}}>
                    <div style={{fontSize:11,color:"#555",marginBottom:6}}>同型態 {type}　{typeIsFirst?"（第一筆）":`原 ${typeBefore.n} 筆 → 現 ${typeAfter.n} 筆`}</div>
                    {!typeIsFirst&&<>
                      <div className="impact-row"><span style={{color:"#888"}}>平均</span>
                        <span>{fmt(typeBefore.avg)} → <span style={{color:"#e8e6e0"}}>{fmt(typeAfter.avg)}</span> <span style={{color:dc(typeAfter.avg-typeBefore.avg)}}>{ds(typeAfter.avg-typeBefore.avg)}</span></span>
                      </div>
                      <div className="impact-row"><span style={{color:"#888"}}>標準差</span>
                        <span>{fmt(typeBefore.std,4)} → <span style={{color:typeAfter.std>THRESH_STD?"#E8515A":"#e8e6e0"}}>{fmt(typeAfter.std,4)}{typeAfter.std>THRESH_STD?" ⚠":""}</span> <span style={{color:dc(typeAfter.std-typeBefore.std)}}>{ds(typeAfter.std-typeBefore.std)}</span></span>
                      </div>
                      <div className="impact-row"><span style={{color:"#888"}}>此筆偏差</span>
                        <span style={{color:deviation!=null&&Math.abs(deviation)>THRESH_DEV?"#E8515A":dc(deviation)}}>{ds(deviation)}{deviation!=null&&Math.abs(deviation)>THRESH_DEV?" ⚠":""}</span>
                      </div>
                    </>}
                  </div>
                  {S!==null&&<div>
                    <div style={{fontSize:11,color:"#555",marginBottom:6}}>S={S} 分組　原 {sBefore.n} 筆 → 現 {sAfter.n} 筆</div>
                    <div className="impact-row"><span style={{color:"#888"}}>平均</span>
                      <span>{fmt(sBefore.avg)} → <span style={{color:"#e8e6e0"}}>{fmt(sAfter.avg)}</span> <span style={{color:dc(sAfter.avg!=null&&sBefore.avg!=null?sAfter.avg-sBefore.avg:null)}}>{ds(sAfter.avg!=null&&sBefore.avg!=null?sAfter.avg-sBefore.avg:null)}</span></span>
                    </div>
                    <div className="impact-row"><span style={{color:"#888"}}>標準差</span>
                      <span>{fmt(sBefore.std,4)} → <span style={{color:"#e8e6e0"}}>{fmt(sAfter.std,4)}</span></span>
                    </div>
                  </div>}
                </div>
              );
            })()}
            <div className={`drop-zone${dragging?" drag":""}`}
              onDragOver={e=>{e.preventDefault();setDragging(true)}} onDragLeave={()=>setDragging(false)}
              onDrop={onDrop} onClick={()=>fileRef.current.click()}>
              <div style={{fontSize:28,marginBottom:8}}>↑</div>
              <div style={{fontSize:13,color:"#aaa",marginBottom:4}}>拖曳或點擊上傳 Tracker 匯出的 .txt</div>
              <div style={{fontSize:11,color:"#555"}}>檔名格式：N2S1-1-1.txt</div>
              <input ref={fileRef} type="file" accept=".txt" multiple style={{display:"none"}} onChange={onFileChange}/>
            </div>
            <div style={{marginTop:16,fontSize:11,color:"#444",lineHeight:1.8}}>
              <div>閾值：標準差 &gt; <span style={{color:"#E8515A"}}>{THRESH_STD}</span> ／ 均差 &gt; <span style={{color:"#E8515A"}}>{THRESH_DEV}</span> → 標紅警告</div>
            </div>
          </div>
        )}
      </div>

      {toast&&(
        <div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:toast.ok?"#1a2e1a":"#2e1a1a",
          border:`0.5px solid ${toast.ok?"#34C98A":"#E8515A"}`,borderRadius:6,padding:"10px 18px",
          fontSize:12,color:toast.ok?"#34C98A":"#E8515A",zIndex:999,whiteSpace:"nowrap"}}>
          {toast.msg}
        </div>
      )}
    </div>
  );
}
