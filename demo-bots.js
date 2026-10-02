/* 촬영용 가상 학생. 기존 PostgreSQL 어댑터를 통해 방 단위로만 쓰기 합니다. */
(function (root) {
  'use strict';
  const MAX_PLAYERS = 50;
  function makeProblem(profile, random = Math.random, now = Date.now()) {
    const fakeIndex = Math.floor(random()*5);
    const items = profile.truths.slice();
    const realValue = items[fakeIndex];
    items[fakeIndex] = profile.fakes[fakeIndex];
    return {items,fakeIndex,realValue,submittedAt:now};
  }
  function chooseVote(fakeIndex, accuracy, random = Math.random) {
    if (random()<accuracy) return fakeIndex;
    const wrong=[0,1,2,3,4].filter(index=>index!==fakeIndex);
    return wrong[Math.floor(random()*wrong.length)];
  }
  function createController({getContext,loadBank,onStatus=()=>{},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
    let bankPromise, busy=false, stopped=false, paused=false, generation=0;
    let voteKey=null, queue=[], accuracy=.5, seenWriting=false;
    let workingIds=null;
    const bank=()=>bankPromise??=loadBank().catch(error=>{bankPromise=null;throw error;});
    const ids=context=>{const stored=workingIds||context.room?.settings?.demoBotIds;return (Array.isArray(stored)?stored:[]).filter(id=>context.room?.players?.[id]);};
    const valid=(code,stamp)=>!stopped && getContext()?.code===code && generation===stamp;
    async function add(topicId,count) {
      if(busy)throw Error('봇을 추가하는 중이에요.');
      busy=true;
      try {return await performAdd(topicId,count);}finally{busy=false;workingIds=null;onStatus('');}
    }
    async function performAdd(topicId,count) {
      const context=getContext();
      if(context?.role!=='teacher' || context.room?.state!=='writing')throw Error('선생님 대기실에서 봇을 추가해 주세요.');
      if(!Number.isInteger(count)||count<1||count>MAX_PLAYERS)throw Error('1~50명 사이로 선택해 주세요.');
      const stamp=generation;
      const topics=await bank(), topic=topics.find(item=>item.id===topicId);
      if(generation!==stamp || getContext()?.code!==context.code)throw Error('방이 바뀌어 봇 생성을 멈췄어요.');
      if(!topic)throw Error('음식·운동·동물 시연 주제를 골라 주세요.');
      const settings=context.room.settings || {}, oldIds=ids(context);
      if(settings.demoTopic && settings.demoTopic!==topicId)throw Error('주제를 바꾸려면 시연 봇을 먼저 비워 주세요.');
      if(!settings.demoTopic && Object.keys(context.room.players||{}).length)throw Error('학생이 없는 방에서 시연 봇을 추가해 주세요.');
      const capacity=MAX_PLAYERS-Object.keys(context.room.players||{}).length;
      if(capacity<=0)throw Error('50명이 모두 들어와 있어요.');
      busy=true;stopped=false;paused=false;
      const code=context.code, ref=context.ref;
      const addedIds=oldIds.slice();workingIds=addedIds;
      const profiles=topic.profiles.map(profile=>({profile,key:Math.random()})).sort((a,b)=>a.key-b.key);
      const save=()=>ref.update({topic:topic.label,settings:{...settings,demoTopic:topicId,demoBotIds:addedIds.slice()}});
      try {
        await save();
        for(let i=0;i<Math.min(count,capacity);i++) {
          if(!valid(code,stamp))break;
          const child=ref.child('players').push(), id=child.key;
          let number=1;
          const names=new Set(Object.values(getContext().room.players||{}).map(player=>player.name));
          while(names.has('시연봇 '+String(number).padStart(2,'0')))number++;
          const player={name:'시연봇 '+String(number).padStart(2,'0'),joinedAt:Date.now(),submitted:false};
          await child.set(player);
          addedIds.push(id);await save();
          if(!valid(code,stamp))break;
          await ref.child('problems/'+id).set(makeProblem(profiles[i].profile));
          await child.update({submitted:true});
          onStatus('봇 '+addedIds.length+'명 생성 완료');
          await sleep(100);
        }
      } finally {workingIds=null;busy=false;onStatus('');}
    }
    async function clear() {
      if(busy)throw Error('봇 생성이 끝난 뒤 비워 주세요.');
      const context=getContext();
      if(context?.role!=='teacher' || context.room?.state!=='writing')throw Error('대기실에서 시연 봇을 비워 주세요.');
      busy=true;generation++;voteKey=null;queue=[];
      try {
        for(const id of ids(context)) {
          await context.ref.child('problems/'+id).remove();
          await context.ref.child('players/'+id).remove();
          await sleep(100);
        }
        const settings={...context.room.settings};delete settings.demoTopic;delete settings.demoBotIds;
        await context.ref.child('settings').set(settings);
      } finally {busy=false;onStatus('');}
    }
    async function tick() {
      const context=getContext();
      if(stopped || busy || paused || context?.role!=='teacher' || !context.room?.settings?.demoTopic)return;
      const botIds=ids(context);
      if(context.room.state==='writing') {
        seenWriting=true;voteKey=null;queue=[];
        const waiting=botIds.find(id=>context.room.players[id]?.submitted===false);
        if(!waiting)return;
        busy=true;
        try {
          const topic=(await bank()).find(item=>item.id===context.room.settings.demoTopic);
          if(!topic)return;
          await context.ref.child('problems/'+waiting).set(makeProblem(topic.profiles[Math.floor(Math.random()*100)]));
          await context.ref.child('players/'+waiting).update({submitted:true});
        } finally {busy=false;}
        return;
      }
      if(context.room.state!=='presenting' || context.room.present?.revealed || context.room.present?.countdown)return;
      const present=context.room.present, owner=present.order?.[present.idx], problem=context.room.problems?.[owner];
      if(!owner || !problem)return;
      const key=context.code+':'+owner+':'+present.idx+':'+problem.submittedAt;
      if(voteKey!==key) {
        voteKey=key;
        // 촬영 중 정답률이 8~10%씩 움직이고, 맞히는 학생은 매번 무작위로 바뀝니다.
        accuracy=[.42,.50,.58,.66,.72,.62,.52,.44,.36,.46][present.idx%10];
        const existing=context.room.votes?.[owner]||{};
        const voters=botIds.filter(id=>id!==owner);
        queue=voters.filter(id=>seenWriting||existing[id]===undefined).map(id=>({id,key:Math.random()})).sort((a,b)=>a.key-b.key);
        const previousCorrect=seenWriting?0:voters.filter(id=>existing[id]===problem.fakeIndex).length;
        const needed=Math.max(0,Math.round(voters.length*accuracy)-previousCorrect);
        queue=queue.map((item,index)=>({id:item.id,correct:index<needed}));
      }
      const voter=queue.shift();
      if(!voter)return;
      busy=true;
      try {await context.ref.child('votes/'+owner+'/'+voter.id).set(chooseVote(problem.fakeIndex,voter.correct?1:0));}
      catch(error){queue.unshift(voter);paused=true;onStatus('연결을 확인하고 봇 계속 진행을 눌러 주세요.');throw error;}
      finally {busy=false;}
    }
    return {add,clear,tick,
      pause(){paused=!paused;return paused;},
      start(){stopped=false;},
      stop(){stopped=true;generation++;voteKey=null;queue=[];workingIds=null;seenWriting=false;paused=false;},
      get paused(){return paused;},get busy(){return busy;}
    };
  }
  root.JJGDemo={MAX_PLAYERS,makeProblem,chooseVote,createController};
})(window);
