const ALLOWED_INTERVALS = new Set(["1min","5min","15min","1h","4h"]);
const TFS = ["1min","5min","15min","1h","4h"];

function cors(){
  return {
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods":"GET, OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type",
    "Content-Type":"application/json; charset=utf-8"
  };
}

function json(data,status=200){
  return new Response(JSON.stringify(data,null,2),{
    status,
    headers:cors()
  });
}

function n(v){ return Number(v); }

function ema(a,p){
  if(a.length<p)return null;
  const k=2/(p+1);
  let e=a.slice(0,p).reduce((x,y)=>x+y,0)/p;
  for(let i=p;i<a.length;i++) e=a[i]*k+e*(1-k);
  return e;
}

function rsi(a,p=14){
  if(a.length<=p)return null;
  let g=0,l=0;
  for(let i=1;i<=p;i++){
    const d=a[i]-a[i-1];
    if(d>=0)g+=d;else l-=d;
  }
  let ag=g/p,al=l/p;
  for(let i=p+1;i<a.length;i++){
    const d=a[i]-a[i-1];
    ag=((ag*(p-1))+Math.max(d,0))/p;
    al=((al*(p-1))+Math.max(-d,0))/p;
  }
  if(al===0)return 100;
  return 100-(100/(1+ag/al));
}

function atr(c,p=14){
  if(c.length<=p)return null;
  const tr=[];
  for(let i=0;i<c.length;i++){
    if(i===0)tr.push(c[i].high-c[i].low);
    else{
      const pc=c[i-1].close;
      tr.push(Math.max(
        c[i].high-c[i].low,
        Math.abs(c[i].high-pc),
        Math.abs(c[i].low-pc)
      ));
    }
  }
  let x=tr.slice(0,p).reduce((a,b)=>a+b,0)/p;
  for(let i=p;i<tr.length;i++)
    x=((x*(p-1))+tr[i])/p;
  return x;
}

function macd(a){
  if(a.length<35)
    return {macd:null,signal:null,histogram:null};

  const ef=12,es=26,sg=9;
  const kf=2/(ef+1),ks=2/(es+1),kg=2/(sg+1);

  let f=a.slice(0,ef).reduce((x,y)=>x+y,0)/ef;
  let s=a.slice(0,es).reduce((x,y)=>x+y,0)/es;
  const m=[];

  for(let i=ef;i<es;i++)
    f=a[i]*kf+f*(1-kf);

  for(let i=es;i<a.length;i++){
    f=a[i]*kf+f*(1-kf);
    s=a[i]*ks+s*(1-ks);
    m.push(f-s);
  }

  let sig=m.slice(0,sg).reduce((x,y)=>x+y,0)/sg;
  for(let i=sg;i<m.length;i++)
    sig=m[i]*kg+sig*(1-kg);

  const last=m[m.length-1];

  return {
    macd:last,
    signal:sig,
    histogram:last-sig
  };
}

function structure(c){
  const highs=[],lows=[];
  for(let i=2;i<c.length-2;i++){
    let hi=true,lo=true;
    for(let j=i-2;j<=i+2;j++){
      if(j===i)continue;
      if(c[j].high>=c[i].high)hi=false;
      if(c[j].low<=c[i].low)lo=false;
    }
    if(hi)highs.push(c[i].high);
    if(lo)lows.push(c[i].low);
  }

  const h=highs.slice(-2),l=lows.slice(-2);
  let s="RANGE";

  if(h.length===2&&l.length===2){
    if(h[1]>h[0]&&l[1]>l[0])s="BULLISH";
    if(h[1]<h[0]&&l[1]<l[0])s="BEARISH";
  }

  const price=c[c.length-1].close;
  let bos="NONE";

  if(h.length&&price>h[h.length-1])bos="BULLISH_BOS";
  if(l.length&&price<l[l.length-1])bos="BEARISH_BOS";

  return {
    structure:s,
    bos,
    swingHigh:h.length?h[h.length-1]:null,
    swingLow:l.length?l[l.length-1]:null
  };
}

function sweep(c){
  if(c.length<22)return {type:"NONE",level:null};

  const last=c[c.length-1];
  const old=c.slice(-21,-1);
  const high=Math.max(...old.map(x=>x.high));
  const low=Math.min(...old.map(x=>x.low));

  if(last.high>high&&last.close<high)
    return {type:"BUY_SIDE_SWEEP",level:high};

  if(last.low<low&&last.close>low)
    return {type:"SELL_SIDE_SWEEP",level:low};

  return {type:"NONE",level:null};
}

function analyze(c){
  const close=c.map(x=>x.close);
  const price=close.at(-1);

  const e20=ema(close,20);
  const e50=ema(close,50);
  const e200=ema(close,200);
  const r=rsi(close);
  const a=atr(c);
  const m=macd(close);
  const st=structure(c);
  const sw=sweep(c);

  let trend="NEUTRAL";

  if(e20&&e50&&e200){
    if(price>e20&&e20>e50&&e50>e200)
      trend="BULLISH";
    else if(price<e20&&e20<e50&&e50<e200)
      trend="BEARISH";
  }

  return {
    price,
    ema20:e20,
    ema50:e50,
    ema200:e200,
    rsi14:r,
    atr14:a,
    macd:m,
    trend,
    structure:st,
    liquiditySweep:sw
  };
}

function score(x){
  let bull=0,bear=0;

  if(x.trend==="BULLISH")bull+=25;
  if(x.trend==="BEARISH")bear+=25;

  if(x.structure.structure==="BULLISH")bull+=20;
  if(x.structure.structure==="BEARISH")bear+=20;

  if(x.structure.bos==="BULLISH_BOS")bull+=15;
  if(x.structure.bos==="BEARISH_BOS")bear+=15;

  if(x.rsi14!==null){
    if(x.rsi14>=52&&x.rsi14<=70)bull+=10;
    if(x.rsi14<=48&&x.rsi14>=30)bear+=10;
  }

  if(x.macd.histogram!==null){
    if(x.macd.histogram>0)bull+=10;
    if(x.macd.histogram<0)bear+=10;
  }

  if(x.liquiditySweep.type==="SELL_SIDE_SWEEP")bull+=15;
  if(x.liquiditySweep.type==="BUY_SIDE_SWEEP")bear+=15;

  let bias="NEUTRAL";
  if(bull>bear+10)bias="BULLISH";
  if(bear>bull+10)bias="BEARISH";

  return {
    bull,
    bear,
    score:Math.min(100,Math.max(bull,bear)),
    bias
  };
}

async function market(env,interval){
  const u=new URL("https://api.twelvedata.com/time_series");

  u.searchParams.set("symbol","XAU/USD");
  u.searchParams.set("interval",interval);
  u.searchParams.set("outputsize","250");
  u.searchParams.set("apikey",env.TWELVE_DATA_API_KEY);

  const r=await fetch(u);
  const d=await r.json();

  if(!r.ok||d.status==="error")
    throw new Error(JSON.stringify(d));

  return (d.values||[]).map(v=>({
    datetime:v.datetime,
    open:n(v.open),
    high:n(v.high),
    low:n(v.low),
    close:n(v.close),
    volume:v.volume==null?null:n(v.volume)
  })).reverse();
}

function round(v,d=2){
  return v==null||Number.isNaN(v)
    ?null
    :Number(v.toFixed(d));
}

export default {
  async fetch(request,env){

    if(request.method==="OPTIONS")
      return new Response(null,{status:204,headers:cors()});

    if(request.method!=="GET")
      return json({ok:false,error:"GET requests only"},405);

    const url=new URL(request.url);

    if(url.pathname==="/"||url.pathname==="/health"){
      return json({
        ok:true,
        service:"XAU AI API",
        status:"online",
        symbol:"XAU/USD",
        engine:"Technical Engine V1"
      });
    }

    if(!env.TWELVE_DATA_API_KEY)
      return json({
        ok:false,
        error:"TWELVE_DATA_API_KEY is not configured"
      },500);

    if(url.pathname==="/api/market"){
      const interval=url.searchParams.get("interval")||"5min";

      if(!ALLOWED_INTERVALS.has(interval))
        return json({
          ok:false,
          error:"Unsupported interval",
          allowed:[...ALLOWED_INTERVALS]
        },400);

      try{
        const values=await market(env,interval);

        return json({
          ok:true,
          symbol:"XAU/USD",
          interval,
          values
        });
      }catch(e){
        return json({
          ok:false,
          error:"Market data request failed",
          details:String(e.message||e)
        },502);
      }
    }

    if(url.pathname==="/api/analyze"){
      try{
        const raw=await Promise.all(
          TFS.map(tf=>market(env,tf))
        );

        const data={};

        for(let i=0;i<TFS.length;i++)
          data[TFS[i]]=analyze(raw[i]);

        const s={};

        for(const tf of TFS)
          s[tf]=score(data[tf]);

        const bull=
          ["4h","1h","15min"]
          .filter(tf=>s[tf].bias==="BULLISH").length;

        const bear=
          ["4h","1h","15min"]
          .filter(tf=>s[tf].bias==="BEARISH").length;

        let direction="NO TRADE";

        if(
          bull>=2&&
          s["5min"].bias==="BULLISH"&&
          s["1min"].bias!=="BEARISH"
        )direction="BUY";

        if(
          bear>=2&&
          s["5min"].bias==="BEARISH"&&
          s["1min"].bias!=="BULLISH"
        )direction="SELL";

        const setupScore=Math.round(
          (
            s["4h"].score+
            s["1h"].score+
            s["15min"].score+
            s["5min"].score+
            s["1min"].score
          )/5
        );

        if(setupScore<70)
          direction="NO TRADE";

        const price=data["1min"].price;
        const a=data["5min"].atr14;

        let risk={
          entry:round(price),
          stopLoss:null,
          takeProfit1:null,
          takeProfit2:null,
          rrToTP1:null,
          rrToTP2:null
        };

        if((direction==="BUY"||direction==="SELL")&&a){

          const sl=a*1.5;
          const tp1=a*2.25;
          const tp2=a*3;

          if(direction==="BUY"){
            risk.stopLoss=round(price-sl);
            risk.takeProfit1=round(price+tp1);
            risk.takeProfit2=round(price+tp2);
          }else{
            risk.stopLoss=round(price+sl);
            risk.takeProfit1=round(price-tp1);
            risk.takeProfit2=round(price-tp2);
          }

          risk.rrToTP1=1.5;
          risk.rrToTP2=2;
        }

        return json({
          ok:true,
          symbol:"XAU/USD",
          engine:"Technical Engine V1",
          generatedAt:new Date().toISOString(),

          decision:{
            direction,
            setupScore,
            rule:"NO TRADE when alignment is insufficient"
          },

          riskPlan:risk,

          timeframes:Object.fromEntries(
            TFS.map(tf=>[
              tf,
              {
                price:round(data[tf].price,2),
                trend:data[tf].trend,
                structure:data[tf].structure,
                liquiditySweep:data[tf].liquiditySweep,
                indicators:{
                  ema20:round(data[tf].ema20,4),
                  ema50:round(data[tf].ema50,4),
                  ema200:round(data[tf].ema200,4),
                  rsi14:round(data[tf].rsi14),
                  atr14:round(data[tf].atr14,4),
                  macd:{
                    macd:round(data[tf].macd.macd,4),
                    signal:round(data[tf].macd.signal,4),
                    histogram:round(data[tf].macd.histogram,4)
                  }
                },
                score:s[tf]
              }
            ])
          ),

          safety:{
            newsRisk:"NOT CHECKED",
            spread:"NOT CHECKED",
            slippage:"NOT CHECKED",
            note:"Rules-based prototype. No guaranteed win rate."
          }
        });

      }catch(e){
        return json({
          ok:false,
          error:"Analysis failed",
          details:String(e.message||e)
        },502);
      }
    }

    return json({
      ok:false,
      error:"Endpoint not found",
      available:[
        "/health",
        "/api/market?interval=1min",
        "/api/market?interval=5min",
        "/api/market?interval=15min",
        "/api/market?interval=1h",
        "/api/market?interval=4h",
        "/api/analyze"
      ]
    },404);
  }
};
