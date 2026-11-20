"use strict";

// WinScope Score Engine V2
// Inputs are prematch market probabilities and completed-match form only.
// Historical odds-profile neighbors are optional and remain empty until the new
// league-season archive has accumulated enough settled fixtures.
const factorial = n => { let v=1; for(let i=2;i<=n;i++) v*=i; return v; };
const poisson = (k,l) => Math.exp(-l)*Math.pow(l,k)/factorial(k);
const atLeast = (threshold,l) => {
  let below=0;
  for(let k=0;k<threshold;k++) below += poisson(k,l);
  return Math.max(0,Math.min(1,1-below));
};
const clamp = (v,min,max) => Math.max(min,Math.min(max,v));
const parseScore = s => {
  const m=String(s||"").match(/(\d+)\s*[-:]\s*(\d+)/);
  return m ? {home:Number(m[1]),away:Number(m[2])} : null;
};
function scoreGrid(lh,la,max=9) {
  const cells=[];
  let sum=0;
  for(let h=0;h<=max;h++) for(let a=0;a<=max;a++){
    const p=poisson(h,lh)*poisson(a,la);
    cells.push({home:h,away:a,probability:p}); sum+=p;
  }
  for(const x of cells) x.probability/=sum||1;
  return cells;
}
function fitLambdas(markets, outcome, homeForm, awayForm, historicalSamples=[]) {
  const targets=[];
  const add=(key,p,w)=>{p=Number(p);if(Number.isFinite(p)&&p>=0.02&&p<=0.98)targets.push({key,p,w});};
  if(outcome){add("home",outcome.home,4.5);add("draw",outcome.draw,4.5);add("away",outcome.away,4.5);}
  add("over15",markets["MS 1.5 ÜST"],1.1);
  add("over25",markets["MS 2.5 ÜST"],2.5);
  add("over35",markets["MS 3.5 ÜST"],1.4);
  add("over45",markets["MS 4.5 ÜST"],0.7);
  add("btts",markets["KG VAR"],1.8);
  add("home15",markets["EV 1.5 ÜST"],1.1);
  add("away15",markets["DEP 1.5 ÜST"],1.1);

  const hf=homeForm?.available?Number(homeForm.avgGoalsFor||0):null;
  const ha=awayForm?.available?Number(awayForm.avgGoalsAgainst||0):null;
  const af=awayForm?.available?Number(awayForm.avgGoalsFor||0):null;
  const hca=homeForm?.available?Number(homeForm.avgGoalsAgainst||0):null;
  const priorH=hf==null||ha==null?null:clamp(.58*hf+.42*ha,.15,3.8);
  const priorA=af==null||hca==null?null:clamp(.58*af+.42*hca,.15,3.8);

  // Similar historical odds profiles are blended only when the archive has
  // at least 25 earlier, settled matches. The caller must pass past matches only.
  let neighborH=null,neighborA=null,neighborWeight=0;
  if(Array.isArray(historicalSamples)&&historicalSamples.length>=25){
    const usable=historicalSamples.filter(x=>Number.isFinite(Number(x.homeGoals))&&Number.isFinite(Number(x.awayGoals)));
    if(usable.length>=25){
      const weights=usable.map(x=>Math.max(0.001,Number(x.similarity||0)));
      const total=weights.reduce((a,b)=>a+b,0);
      if(total>0){
        neighborH=usable.reduce((s,x,i)=>s+Number(x.homeGoals)*weights[i],0)/total;
        neighborA=usable.reduce((s,x,i)=>s+Number(x.awayGoals)*weights[i],0)/total;
        neighborWeight=Math.min(.30,usable.length/200);
      }
    }
  }
  const stats=(lh,la)=>{
    let home=0,draw=0,away=0,over15=0,over25=0,over35=0,over45=0,btts=0,home15=0,away15=0;
    for(const x of scoreGrid(lh,la,9)){
      const h=x.home,a=x.away,t=h+a,p=x.probability;
      if(h>a)home+=p;else if(h===a)draw+=p;else away+=p;
      if(t>=2)over15+=p;if(t>=3)over25+=p;if(t>=4)over35+=p;if(t>=5)over45+=p;
      if(h>0&&a>0)btts+=p;if(h>=2)home15+=p;if(a>=2)away15+=p;
    }
    return {home,draw,away,over15,over25,over35,over45,btts,home15,away15};
  };
  const loss=(h,a)=>{
    const s=stats(h,a);let err=0,w=0;
    for(const t of targets){err+=t.w*Math.pow(s[t.key]-t.p,2);w+=t.w;}
    if(priorH!=null){err+=.16*Math.pow(h-priorH,2);w+=.16;}
    if(priorA!=null){err+=.16*Math.pow(a-priorA,2);w+=.16;}
    if(neighborH!=null){err+=neighborWeight*Math.pow(h-neighborH,2);w+=neighborWeight;}
    if(neighborA!=null){err+=neighborWeight*Math.pow(a-neighborA,2);w+=neighborWeight;}
    return w?err/w:Infinity;
  };
  let best=Infinity,bh=null,ba=null;
  for(let h=.15;h<=3.8;h+=.10)for(let a=.15;a<=3.8;a+=.10){
    const e=loss(h,a);if(e<best){best=e;bh=h;ba=a;}
  }
  if(bh==null)return null;
  const ch=bh,ca=ba;
  for(let h=Math.max(.08,ch-.12);h<=Math.min(4.2,ch+.12);h+=.02)
    for(let a=Math.max(.08,ca-.12);a<=Math.min(4.2,ca+.12);a+=.02){
      const e=loss(h,a);if(e<best){best=e;bh=h;ba=a;}
    }
  return {home:clamp(bh,.08,4.5),away:clamp(ba,.08,4.5),fitError:best,stats:stats(bh,ba),
    usedHistoricalNeighbors:neighborH!=null,neighborSampleSize:neighborH==null?0:historicalSamples.length};
}
function predictScore({fixture={},homeForm=null,awayForm=null,markets={},outcome=null,preferredMarket=null,historicalSamples=[]}={}) {
  const fit=fitLambdas(markets,outcome,homeForm,awayForm,historicalSamples);
  if(!fit)return {halfTimeScore:"Tahmin üretilemedi",fullTimeScore:"Tahmin üretilemedi",
    alternativeFullTimeScore:"Tahmin üretilemedi",scoreBasis:"Yeterli maç önü oranı veya takım formu yok",
    modelVersion:"V2_ODDS_PROFILE_NEIGHBORS"};
  const cells=scoreGrid(fit.home,fit.away,9).sort((a,b)=>b.probability-a.probability||
    (a.home+a.away)-(b.home+b.away)||b.home-a.home);
  const best=cells[0],alt=cells[1]||best;
  const ht05=Number(markets["İY 0.5 ÜST"]),ht15=Number(markets["İY 1.5 ÜST"]);
  let htLambda=null,err=Infinity;
  if(Number.isFinite(ht05)||Number.isFinite(ht15)){
    for(let l=.05;l<=4;l+=.005){
      const e=(Number.isFinite(ht05)?Math.pow(atLeast(1,l)-ht05,2):0)+
        (Number.isFinite(ht15)?Math.pow(atLeast(2,l)-ht15,2):0);
      if(e<err){err=e;htLambda=l;}
    }
  }
  const hfHt=homeForm?.available?Number(homeForm.htAvgGoalsFor):NaN;
  const afHt=awayForm?.available?Number(awayForm.htAvgGoalsFor):NaN;
  const totalHt=htLambda==null?.44*(fit.home+fit.away):htLambda;
  const share=Number.isFinite(hfHt)&&Number.isFinite(afHt)&&hfHt+afHt>0?hfHt/(hfHt+afHt):fit.home/(fit.home+fit.away);
  const htHome=totalHt*share,htAway=totalHt*(1-share);
  const htScores=[];
  const binom=(n,k,p)=>{if(k<0||k>n)return 0;let c=1;for(let i=1;i<=k;i++)c=c*(n-i+1)/i;return c*Math.pow(p,k)*Math.pow(1-p,n-k);};
  const ph=clamp(htHome/fit.home,.01,.95),pa=clamp(htAway/fit.away,.01,.95);
  for(let h=0;h<=best.home;h++)for(let a=0;a<=best.away;a++)
    htScores.push({home:h,away:a,p:binom(best.home,h,ph)*binom(best.away,a,pa)});
  htScores.sort((a,b)=>b.p-a.p||(a.home+a.away)-(b.home+b.away));
  const sixPlus=cells.reduce((s,x)=>s+(x.home+x.away>=6?x.probability:0),0);
  const matrix=fit.stats;
  const scoreBasis=["maç önü 1X2 ve gol çizgileri",homeForm?.available&&awayForm?.available?"iki takımın son 5 maç formu":null,
    fit.usedHistoricalNeighbors?"benzer geçmiş oran profilleri": "geçmiş oran profili arşivi henüz yeterli değil"].filter(Boolean).join(" + ");
  return {
    halfTimeScore:`${htScores[0]?.home??0}-${htScores[0]?.away??0} (tahmin)`,
    fullTimeScore:`${best.home}-${best.away} (tahmin)`,
    alternativeFullTimeScore:`${alt.home}-${alt.away} (alternatif tahmin)`,
    unconditionalFullTimeScore:`${best.home}-${best.away}`,
    unconditionalAlternativeFullTimeScore:`${alt.home}-${alt.away}`,
    predictedScoreProbability:Number(best.probability.toFixed(4)),
    scoreProbability:Number(best.probability.toFixed(4)),
    alternativeScoreProbability:Number(alt.probability.toFixed(4)),
    sixPlusProbability:Number(sixPlus.toFixed(4)),sixPlusCandidate:sixPlus>=.20,
    marketScenarioScore:`${best.home}-${best.away} (tercih senaryosu)`,
    marketScenarioAlternativeScore:`${alt.home}-${alt.away} (tercih senaryosu alternatifi)`,
    marketScenarioProbability:Number(best.probability.toFixed(4)),
    scoreCondition:preferredMarket||"UNCONDITIONAL",
    scoreProbabilityType:"UNCONDITIONAL",
    scoreBasis,expectedGoals:{home:Number(fit.home.toFixed(2)),away:Number(fit.away.toFixed(2))},
    expectedHalfTimeGoals:{home:Number(htHome.toFixed(2)),away:Number(htAway.toFixed(2)),total:Number(totalHt.toFixed(2))},
    halfTimeBasis:htLambda==null?"maç önü İY oranı yok; tam maç gol beklentisinin %44 yedeği":"maç önü ilk yarı gol oranları",
    matrixMarketProbabilities:{
      "KG VAR":matrix.btts,"MS 2.5 ÜST":matrix.over25,"EV 1.5 ÜST":matrix.home15,
      "DEP 1.5 ÜST":matrix.away15,"MS 1.5 ÜST":matrix.over15,"MS 3.5 ÜST":matrix.over35,
      "MS 4.5 ÜST":matrix.over45
    },
    topScoreCandidates:cells.slice(0,3).map(x=>({score:`${x.home}-${x.away}`,probability:Number(x.probability.toFixed(4))})),
    marketScenarioCandidates:cells.slice(0,3).map(x=>({score:`${x.home}-${x.away}`,conditionalProbability:Number(x.probability.toFixed(4))})),
    scoreModelMethod:"V2_PREMATCH_MARKET_FIT_LAST5_FORM_AND_OPTIONAL_HISTORICAL_ODDS_NEIGHBORS",
    modelVersion:"V2_ODDS_PROFILE_NEIGHBORS",htFtConsistency:true,
    halfTimeScoreProbability:Number((htScores[0]?.p||0).toFixed(4)),
    htTeamFormUsed:Number.isFinite(hfHt)&&Number.isFinite(afHt),
    htFormSampleSize:{home:Number(homeForm?.htSampleSize||0),away:Number(awayForm?.htSampleSize||0)},
    modelFitError:Number(fit.fitError.toFixed(6)),
    marketTargetsUsed:Object.keys(markets).filter(k=>Number.isFinite(Number(markets[k]))),
    historicalNeighborSampleSize:fit.neighborSampleSize,
    historicalNeighborsUsed:fit.usedHistoricalNeighbors,
    oddsBookmaker:null,market1x2:outcome
  };
}
module.exports={predictScore};
