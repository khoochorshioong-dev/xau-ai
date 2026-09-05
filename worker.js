const ALLOWED_INTERVALS = new Set(["1min","5min","15min","1h","4h"]);
const TFS = ["1min","5min","15min","1h","4h"];

const CACHE_TTL = 15;

const FRESHNESS_LIMITS = {
  "1min": 10 * 60,
  "5min": 30 * 60,
  "15min": 90 * 60,
  "1h": 4 * 60 * 60,
  "4h": 16 * 60 * 60
};

function cors(){
  return {
    "Access-Control-Allow-Origin":"*",
    "Access-Control-Allow-Methods":"GET, OPTIONS",
    "Access-Control-Allow-Headers":"Content-Type",
    "Content-Type":"application/json; charset=utf-8",
    "Cache-Control":"no-store"
  };
}

function json(data,status=200){
  return new Response(JSON.stringify(data,null,2),{
    status,
    headers:cors()
  });
}

function n(v){
  return Number(v);
}

function ema(a,p){
  if(a.length<p)return null;

  const k=2/(p+1);

  let e=a.slice(0,p)
    .reduce((x,y)=>x+y,0)/p;

  for(let i=p;i<a.length;i++){
    e=a[i]*k+e*(1-k);
  }

  return e;
}

function rsi(a,p=14){
  if(a.length<=p)return null;

  let g=0,l=0;

  for(let i=1;i<=p;i++){
    const d=a[i]-a[i-1];

    if(d>=0)g+=d;
    else l-=d;
  }

  let ag=g/p;
  let al=l/p;

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

    if(i===0){
      tr.push(c[i].high-c[i].low);
    }else{

      const pc=c[i-1].close;

      tr.push(
        Math.max(
          c[i].high-c[i].low,
          Math.abs(c[i].high-pc),
          Math.abs(c[i].low-pc)
        )
      );
    }
  }

  let x=tr.slice(0,p)
    .reduce((a,b)=>a+b,0)/p;

  for(let i=p;i<tr.length;i++){
    x=((x*(p-1))+tr[i])/p;
  }

  return x;
}

function macd(a){

  if(a.length<35){
    return {
      macd:null,
      signal:null,
      histogram:null
    };
  }

  const ef=12;
  const es=26;
  const sg=9;

  const kf=2/(ef+1);
  const ks=2/(es+1);
  const kg=2/(sg+1);

  let f=a.slice(0,ef)
    .reduce((x,y)=>x+y,0)/ef;

  let s=a.slice(0,es)
    .reduce((x,y)=>x+y,0)/es;

  const m=[];

  for(let i=ef;i<es;i++){
    f=a[i]*kf+f*(1-kf);
  }

  for(let i=es;i<a.length;i++){

    f=a[i]*kf+f*(1-kf);
    s=a[i]*ks+s*(1-ks);

    m.push(f-s);
  }

  if(m.length<sg){
    return {
      macd:null,
      signal:null,
      histogram:null
    };
  }

  let sig=m.slice(0,sg)
    .reduce((x,y)=>x+y,0)/sg;

  for(let i=sg;i<m.length;i++){
    sig=m[i]*kg+sig*(1-kg);
  }

  const last=m[m.length-1];

  return {
    macd:last,
    signal:sig,
    histogram:last-sig
  };
}

function structure(c){

  const highs=[];
  const lows=[];

  for(let i=2;i<c.length-2;i++){

    let hi=true;
    let lo=true;

    for(let j=i-2;j<=i+2;j++){

      if(j===i)continue;

      if(c[j].high>=c[i].high)
        hi=false;

      if(c[j].low<=c[i].low)
        lo=false;
    }

    if(hi)highs.push(c[i].high);
    if(lo)lows.push(c[i].low);
  }

  const h=highs.slice(-2);
  const l=lows.slice(-2);

  let s="RANGE";

  if(h.length===2&&l.length===2){

    if(
      h[1]>h[0] &&
      l[1]>l[0]
    ){
      s="BULLISH";
    }

    if(
      h[1]<h[0] &&
      l[1]<l[0]
    ){
      s="BEARISH";
    }
  }

  const price=c[c.length-1].close;

  let bos="NONE";

  if(
    h.length &&
    price>h[h.length-1]
  ){
    bos="BULLISH_BOS";
  }

  if(
    l.length &&
    price<l[l.length-1]
  ){
    bos="BEARISH_BOS";
  }

  return {
    structure:s,
    bos,
    swingHigh:h.length?h[h.length-1]:null,
    swingLow:l.length?l[l.length-1]:null
  };
}

function sweep(c){

  if(c.length<22){
    return {
      type:"NONE",
      level:null
    };
  }

  const last=c[c.length-1];
  const old=c.slice(-21,-1);

  const high=Math.max(
    ...old.map(x=>x.high)
  );

  const low=Math.min(
    ...old.map(x=>x.low)
  );

  if(
    last.high>high &&
    last.close<high
  ){
    return {
      type:"BUY_SIDE_SWEEP",
      level:high
    };
  }

  if(
    last.low<low &&
    last.close>low
  ){
    return {
      type:"SELL_SIDE_SWEEP",
      level:low
    };
  }

  return {
    type:"NONE",
    level:null
  };
}

function analyze(c){

  const close=c.map(x=>x.close);

  const price=close[close.length-1];

  const e20=ema(close,20);
  const e50=ema(close,50);
  const e200=ema(close,200);

  const r=rsi(close);
  const a=atr(c);
  const m=macd(close);

  const st=structure(c);
  const sw=sweep(c);

  let trend="NEUTRAL";

  if(e20!==null&&e50!==null&&e200!==null){

    if(
      price>e20 &&
      e20>e50 &&
      e50>e200
    ){
      trend="BULLISH";
    }

    else if(
      price<e20 &&
      e20<e50 &&
      e50<e200
    ){
      trend="BEARISH";
    }
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

  let bull=0;
  let bear=0;

  if(x.trend==="BULLISH")
    bull+=25;

  if(x.trend==="BEARISH")
    bear+=25;

  if(x.structure.structure==="BULLISH")
    bull+=20;

  if(x.structure.structure==="BEARISH")
    bear+=20;

  if(x.structure.bos==="BULLISH_BOS")
    bull+=15;

  if(x.structure.bos==="BEARISH_BOS")
    bear+=15;

  if(x.rsi14!==null){

    if(
      x.rsi14>=52 &&
      x.rsi14<=70
    ){
      bull+=10;
    }

    if(
      x.rsi14<=48 &&
      x.rsi14>=30
    ){
      bear+=10;
    }
  }

  if(x.macd.histogram!==null){

    if(x.macd.histogram>0)
      bull+=10;

    if(x.macd.histogram<0)
      bear+=10;
  }

  if(
    x.liquiditySweep.type==="SELL_SIDE_SWEEP"
  ){
    bull+=15;
  }

  if(
    x.liquiditySweep.type==="BUY_SIDE_SWEEP"
  ){
    bear+=15;
  }

  let bias="NEUTRAL";

  if(bull>bear+10)
    bias="BULLISH";

  if(bear>bull+10)
    bias="BEARISH";

  return {
    bull,
    bear,
    score:Math.min(
      100,
      Math.max(bull,bear)
    ),
    bias
  };
}

function parseDateTime(value){

  if(!value)return null;

  const d=new Date(value);

  if(Number.isNaN(d.getTime()))
    return null;

  return d;
}

function isFresh(candles,interval){

  if(!candles.length){
    return {
      fresh:false,
      ageSeconds:null
    };
  }

  const latest=candles[candles.length-1];

  const d=parseDateTime(latest.datetime);

  if(!d){
    return {
      fresh:false,
      ageSeconds:null
    };
  }

  const ageSeconds=
    Math.max(
      0,
      (Date.now()-d.getTime())/1000
    );

  return {
    fresh:
      ageSeconds<=FRESHNESS_LIMITS[interval],
    ageSeconds
  };
}

function isWeekend(){

  const day=new Date().getUTCDay();

  return day===0||day===6;
}

async function fetchTwelveData(env,interval){

  const u=new URL(
    "https://api.twelvedata.com/time_series"
  );

  u.searchParams.set(
    "symbol",
    "XAU/USD"
  );

  u.searchParams.set(
    "interval",
    interval
  );

  u.searchParams.set(
    "outputsize",
    "250"
  );

  u.searchParams.set(
    "timezone",
    "UTC"
  );

  u.searchParams.set(
    "apikey",
    env.TWELVE_DATA_API_KEY
  );

  const r=await fetch(u);

  let d;

  try{
    d=await r.json();
  }catch{
    throw new Error(
      "Invalid response from Twelve Data"
    );
  }

  if(
    r.status===429 ||
    d?.code===429
  ){

    const error=new Error(
      "Twelve Data rate limit exceeded"
    );

    error.code=429;
    error.provider=d;

    throw error;
  }

  if(
    !r.ok ||
    d?.status==="error"
  ){

    const error=new Error(
      d?.message ||
      "Twelve Data request failed"
    );

    error.code=d?.code||r.status;

    error.provider=d;

    throw error;
  }

  const values=(d.values||[])
    .map(v=>({
      datetime:v.datetime,
      open:n(v.open),
      high:n(v.high),
      low:n(v.low),
      close:n(v.close),
      volume:
        v.volume==null
          ?null
          :n(v.volume)
    }))
    .reverse();

  if(values.length<50){

    throw new Error(
      `Insufficient candles for ${interval}`
    );
  }

  return values;
}

async function market(env,interval){

  const cache=
    caches.default;

  const cacheKey=
    new Request(
      `https://xau-ai-cache.local/market/${interval}`
    );

  const cached=
    await cache.match(cacheKey);

  if(cached){

    const values=
      await cached.json();

    return {
      values,
      cached:true
    };
  }

  const values=
    await fetchTwelveData(
      env,
      interval
    );

  const response=
    new Response(
      JSON.stringify(values),
      {
        headers:{
          "Content-Type":
            "application/json",
          "Cache-Control":
            `public, max-age=${CACHE_TTL}`
        }
      }
    );

  await cache.put(
    cacheKey,
    response.clone()
  );

  return {
    values,
    cached:false
  };
}

function round(v,d=2){

  return v==null ||
    Number.isNaN(v)
      ?null
      :Number(v.toFixed(d));
}

function riskPlan(
  direction,
  price,
  atrValue
){

  const risk={
    entry:round(price),
    stopLoss:null,
    takeProfit1:null,
    takeProfit2:null,
    rrToTP1:null,
    rrToTP2:null
  };

  if(
    direction!=="BUY" &&
    direction!=="SELL"
  ){
    return risk;
  }

  if(
    atrValue===null ||
    !Number.isFinite(atrValue) ||
    atrValue<=0
  ){
    return risk;
  }

  const sl=atrValue*1.5;
  const tp1=atrValue*2.25;
  const tp2=atrValue*3;

  if(direction==="BUY"){

    risk.stopLoss=
      round(price-sl);

    risk.takeProfit1=
      round(price+tp1);

    risk.takeProfit2=
      round(price+tp2);

  }else{

    risk.stopLoss=
      round(price+sl);

    risk.takeProfit1=
      round(price-tp1);

    risk.takeProfit2=
      round(price-tp2);
  }

  risk.rrToTP1=1.5;
  risk.rrToTP2=2;

  return risk;
}

export default {

  async fetch(request,env){

    if(request.method==="OPTIONS"){

      return new Response(
        null,
        {
          status:204,
          headers:cors()
        }
      );
    }

    if(request.method!=="GET"){

      return json(
        {
          ok:false,
          error:"GET requests only"
        },
        405
      );
    }

    const url=
      new URL(request.url);

    if(
      url.pathname==="/" ||
      url.pathname==="/health"
    ){

      return json({
        ok:true,
        service:"XAU AI API",
        status:"online",
        symbol:"XAU/USD",
        engine:"Technical Engine V2.0",
        cacheTtlSeconds:CACHE_TTL
      });
    }

    if(!env.TWELVE_DATA_API_KEY){

      return json(
        {
          ok:false,
          error:
            "TWELVE_DATA_API_KEY is not configured"
        },
        500
      );
    }

    if(url.pathname==="/api/market"){

      const interval=
        url.searchParams.get("interval")||
        "5min";

      if(
        !ALLOWED_INTERVALS.has(interval)
      ){

        return json(
          {
            ok:false,
            error:"Unsupported interval",
            allowed:[...ALLOWED_INTERVALS]
          },
          400
        );
      }

      try{

        const result=
          await market(
            env,
            interval
          );

        const freshness=
          isFresh(
            result.values,
            interval
          );

        return json({
          ok:true,
          symbol:"XAU/USD",
          interval,
          cached:result.cached,
          candleCount:result.values.length,
          latestDatetime:
            result.values[
              result.values.length-1
            ]?.datetime||null,
          freshness,
          values:result.values
        });

      }catch(e){

        if(e.code===429){

          return json(
            {
              ok:false,
              error:"DATA_LIMIT",
              provider:"Twelve Data",
              message:
                "Twelve Data API credit limit reached. Wait for the next quota window.",
              details:
                e.provider||null
            },
            429
          );
        }

        return json(
          {
            ok:false,
            error:"Market data request failed",
            details:String(
              e.message||e
            )
          },
          502
        );
      }
    }

    if(url.pathname==="/api/analyze"){

      const generatedAt=
        new Date().toISOString();

      /*
       * XAU/USD is normally closed over the weekend.
       * Never generate a live BUY/SELL signal
       * during Saturday/Sunday.
       */

      if(isWeekend()){

        return json({

          ok:true,

          symbol:"XAU/USD",

          engine:"Technical Engine V2.0",

          generatedAt,

          decision:{
            direction:"NO TRADE",
            setupScore:0,
            rule:
              "Weekend market filter"
          },

          riskPlan:{
            entry:null,
            stopLoss:null,
            takeProfit1:null,
            takeProfit2:null,
            rrToTP1:null,
            rrToTP2:null
          },

          safety:{
            weekend:true,
            newsRisk:"NOT CHECKED",
            spread:"NOT CHECKED",
            slippage:"NOT CHECKED",
            dataFreshness:"NOT CHECKED",
            note:
              "XAU/USD weekend filter active. No trading signal generated."
          }

        });
      }

      try{

        const rawResults=
          await Promise.allSettled(
            TFS.map(
              tf=>market(env,tf)
            )
          );

        const data={};
        const freshness={};
        const unavailable=[];

        for(
          let i=0;
          i<TFS.length;
          i++
        ){

          const tf=TFS[i];

          const result=
            rawResults[i];

          if(
            result.status!=="fulfilled"
          ){

            unavailable.push({
              timeframe:tf,
              reason:
                String(
                  result.reason?.message||
                  result.reason||
                  "Unknown error"
                ),
              code:
                result.reason?.code||
                null
            });

            continue;
          }

          data[tf]=result.value.values;

          freshness[tf]=
            isFresh(
              data[tf],
              tf
            );
        }

        /*
         * If any timeframe failed,
         * do NOT manufacture a signal.
         */

        if(unavailable.length){

          return json({

            ok:true,

            symbol:"XAU/USD",

            engine:"Technical Engine V2.0",

            generatedAt,

            decision:{
              direction:"NO TRADE",
              setupScore:0,
              rule:
                "Required timeframe data unavailable"
            },

            riskPlan:{
              entry:null,
              stopLoss:null,
              takeProfit1:null,
              takeProfit2:null,
              rrToTP1:null,
              rrToTP2:null
            },

            unavailable,

            freshness,

            safety:{
              weekend:false,
              newsRisk:"NOT CHECKED",
              spread:"NOT CHECKED",
              slippage:"NOT CHECKED",
              dataFreshness:"FAILED",
              note:
                "NO TRADE because required market data could not be loaded."
            }

          });
        }

        /*
         * Freshness gate.
         * Old data = NO TRADE.
         */

        const stale=
          TFS.filter(
            tf=>!freshness[tf].fresh
          );

        if(stale.length){

          return json({

            ok:true,

            symbol:"XAU/USD",

            engine:"Technical Engine V2.0",

            generatedAt,

            decision:{
              direction:"NO TRADE",
              setupScore:0,
              rule:
                "Stale market data detected"
            },

            riskPlan:{
              entry:null,
              stopLoss:null,
              takeProfit1:null,
              takeProfit2:null,
              rrToTP1:null,
              rrToTP2:null
            },

            freshness,

            staleTimeframes:stale,

            safety:{
              weekend:false,
              newsRisk:"NOT CHECKED",
              spread:"NOT CHECKED",
              slippage:"NOT CHECKED",
              dataFreshness:"STALE",
              note:
                "NO TRADE because one or more timeframe datasets are stale."
            }

          });
        }

        const analysis={};
        const scores={};

        for(const tf of TFS){

          analysis[tf]=
            analyze(data[tf]);

          scores[tf]=
            score(analysis[tf]);
        }

        const bull=
          ["4h","1h","15min"]
            .filter(
              tf=>
                scores[tf].bias==="BULLISH"
            )
            .length;

        const bear=
          ["4h","1h","15min"]
            .filter(
              tf=>
                scores[tf].bias==="BEARISH"
            )
            .length;

        let direction=
          "NO TRADE";

        if(
          bull>=2 &&
          scores["5min"].bias==="BULLISH" &&
          scores["1min"].bias!=="BEARISH"
        ){

          direction="BUY";
        }

        if(
          bear>=2 &&
          scores["5min"].bias==="BEARISH" &&
          scores["1min"].bias!=="BULLISH"
        ){

          direction="SELL";
        }

        const setupScore=
          Math.round(
            TFS.reduce(
              (sum,tf)=>
                sum+scores[tf].score,
              0
            )/TFS.length
          );

        if(setupScore<70){

          direction="NO TRADE";
        }

        const price=
          analysis["1min"].price;

        const atrValue=
          analysis["5min"].atr14;

        const risk=
          riskPlan(
            direction,
            price,
            atrValue
          );

        return json({

          ok:true,

          symbol:"XAU/USD",

          engine:"Technical Engine V2.0",

          generatedAt,

          decision:{
            direction,
            setupScore,
            rule:
              "NO TRADE when alignment is insufficient"
          },

          riskPlan:risk,

          marketStatus:{
            weekend:false,
            allTimeframesFresh:true
          },

          freshness,

          timeframes:
            Object.fromEntries(

              TFS.map(tf=>[

                tf,

                {

                  price:
                    round(
                      analysis[tf].price,
                      2
                    ),

                  trend:
                    analysis[tf].trend,

                  structure:
                    analysis[tf].structure,

                  liquiditySweep:
                    analysis[tf]
                      .liquiditySweep,

                  indicators:{

                    ema20:
                      round(
                        analysis[tf].ema20,
                        4
                      ),

                    ema50:
                      round(
                        analysis[tf].ema50,
                        4
                      ),

                    ema200:
                      round(
                        analysis[tf].ema200,
                        4
                      ),

                    rsi14:
                      round(
                        analysis[tf].rsi14
                      ),

                    atr14:
                      round(
                        analysis[tf].atr14,
                        4
                      ),

                    macd:{

                      macd:
                        round(
                          analysis[tf]
                            .macd.macd,
                          4
                        ),

                      signal:
                        round(
                          analysis[tf]
                            .macd.signal,
                          4
                        ),

                      histogram:
                        round(
                          analysis[tf]
                            .macd.histogram,
                          4
                        )
                    }
                  },

                  score:
                    scores[tf]
                }
              ])
            ),

          safety:{

            weekend:false,

            newsRisk:
              "NOT CHECKED",

            spread:
              "NOT CHECKED",

            slippage:
              "NOT CHECKED",

            dataFreshness:
              "PASSED",

            note:
              "Rules-based prototype. No guaranteed win rate."
          }

        });

      }catch(e){

        return json({

          ok:false,

          error:"Analysis failed",

          details:
            String(
              e.message||e
            )

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
