/* KinoQuiz Firebase layer. The web apiKey below is public by design; security comes from firestore.rules + server. */
window.KQ_CONFIG={apiKey:"AIzaSyDLXZCEc69FZf4k0S1G-eARPdFTM6v-IZA",authDomain:"kino-quizz.firebaseapp.com",projectId:"kino-quizz",storageBucket:"kino-quizz.firebasestorage.app",messagingSenderId:"630969836830",appId:"1:630969836830:web:fa000b1503744b486c550f"};
/* URL of your bot/email server (after deploying on Render), no trailing slash */
window.KQ_SERVER="https://kino-quizz.onrender.com";
(function(){
var V='10.12.2',B='https://www.gstatic.com/firebasejs/'+V+'/firebase-';
['app','auth','firestore','storage'].forEach(function(n){document.write('<script src="'+B+n+'-compat.js"><\/script>')});
window.addEventListener('load',function(){
 if(!window.firebase)return;
 firebase.initializeApp(KQ_CONFIG);
 var auth=firebase.auth(),db=firebase.firestore(),unsub=[],userUnsub=null,ordersUnsub=null,ordersMode=null,sessionSent=false,gen=0;
 var COLS=['news','cols','products','ranks'];
 function app(){return window.kqApp}
 /* ---- calls to our server (Render). Public ones need no sign-in. ---- */
 var CODE_MAP={'email-taken':'auth/email-already-in-use','username-taken':'auth/username-taken','rate':'auth/too-many-requests'};
 function http(path,method,body,token,ms){
  var ctl=window.AbortController?new AbortController():null,timer=setTimeout(function(){if(ctl)ctl.abort()},ms||70000);
  var h={'Content-Type':'application/json'};if(token)h.Authorization='Bearer '+token;
  return fetch(KQ_SERVER+path,{method:method||'POST',headers:h,body:body?JSON.stringify(body):undefined,signal:ctl?ctl.signal:undefined})
   .then(function(r){clearTimeout(timer);return r.json().catch(function(){return {}}).then(function(j){
     if(!r.ok){var e=new Error(j.error||'server');e.code=CODE_MAP[j.code]||j.code||'server/error';e.status=r.status;throw e}
     return j})},
   function(err){clearTimeout(timer);var e=new Error('network');e.code=(err&&err.name==='AbortError')?'server/timeout':'auth/network-request-failed';throw e});
 }
 function pub(path,body,ms){return http(path,'POST',body,null,ms)}
 function call(path,method,body){return auth.currentUser.getIdToken().then(function(tk){return http(path,method,body,tk)})}
 function listen(kind,q){unsub.push(q.onSnapshot(function(s){app().onData(kind,s.docs.map(function(d){var o=d.data();o.id=d.id;return o}))},function(e){app().onError(e)}))}
 function stopAll(){unsub.forEach(function(u){u()});unsub=[];if(userUnsub){userUnsub();userUnsub=null}if(ordersUnsub){ordersUnsub();ordersUnsub=null}ordersMode=null;sessionSent=false}
 function startPublic(){COLS.forEach(function(k){listen(k,db.collection(k))});unsub.push(db.doc('settings/main').onSnapshot(function(s){app().onData('settings',s.data()||{})}))}
 var API={on:true,
  /* Sign-up goes through the server so e-mail AND username are guaranteed unique. */
  signUp:function(email,username,pw,onSlow){
   var slow=setTimeout(function(){if(onSlow)onSlow()},4000);
   return pub('/api/register',{email:email,username:username,password:pw}).then(function(){clearTimeout(slow);return auth.signInWithEmailAndPassword(email,pw)},function(e){clearTimeout(slow);throw e})
  },
  /* identifier = e-mail OR username. */
  signIn:function(identifier,pw,onSlow){
   var id=String(identifier||'').trim();
   if(id.indexOf('@')>0)return auth.signInWithEmailAndPassword(id,pw);
   var slow=setTimeout(function(){if(onSlow)onSlow()},4000);
   return pub('/api/resolve-login',{identifier:id,password:pw}).then(function(r){clearTimeout(slow);return auth.signInWithEmailAndPassword(r.email,pw)},function(e){clearTimeout(slow);throw e})
  },
  signOut:function(){return auth.signOut()},
  /* "Forgot password" by e-mail: the server e-mails a temporary password. */
  forgot:function(identifier){return pub('/api/forgot',{identifier:identifier})},
  status:function(){return fetch(KQ_SERVER+'/api/status').then(function(r){return r.json()}).catch(function(){return null})},
  changePassword:function(oldPw,newPw){
   var u=auth.currentUser,cred=firebase.auth.EmailAuthProvider.credential(u.email,oldPw);
   return u.reauthenticateWithCredential(cred).then(function(){return u.updatePassword(newPw)}).then(function(){return db.doc('users/'+u.uid).update({mustChange:false})})
  },
  save:function(k,it){
   var o=JSON.parse(JSON.stringify(it));delete o.id;
   if(k==='orders'||k==='ranks'){o.uid=auth.currentUser.uid}
   return db.collection(k).doc(it.id).set(o).then(function(){if(k==='orders')call('/api/order-created','POST',{orderId:it.id}).catch(function(e){console.warn('notify',e)})})
  },
  remove:function(k,id){return db.collection(k).doc(id).delete()},
  updateStock:function(id,stock){return db.doc('products/'+id).update({stock:stock})},
  saveUser:function(o){return db.doc('users/'+auth.currentUser.uid).set(o,{merge:true})},
  setSetting:function(o){return db.doc('settings/main').set(o,{merge:true})},
  upload:function(file){var ref=firebase.storage().ref('uploads/'+auth.currentUser.uid+'/'+Date.now()+'_'+file.name.replace(/[^\w.-]/g,'_'));return ref.put(file).then(function(){return ref.getDownloadURL()})},
  createLinkCode:function(){
   var code=Math.random().toString(36).slice(2,8).toUpperCase();
   return db.doc('tgCodes/'+code).set({uid:auth.currentUser.uid,exp:Date.now()+600000}).then(function(){return code})
  },
  listAdmins:function(){return call('/api/admins','GET')},
  addAdmin:function(email){return call('/api/admins','POST',{email:email})},
  removeAdmin:function(uid){return call('/api/admins/remove','POST',{uid:uid})}
 };
 window.KQ=API;

 /* Orders: staff see all, everybody else only their own. Staff need a fresh token (it carries the role). */
 function attachOrders(user,isAdm,g){
  var mode=isAdm?'all':'mine';if(ordersMode===mode)return;
  if(ordersUnsub){ordersUnsub();ordersUnsub=null}ordersMode=mode;
  (isAdm?user.getIdToken(true):Promise.resolve()).then(function(){
   if(g!==gen||ordersMode!==mode)return;
   var q=isAdm?db.collection('orders'):db.collection('orders').where('uid','==',user.uid);
   ordersUnsub=q.onSnapshot(function(s){app().onData('orders',s.docs.map(function(d){var o=d.data();o.id=d.id;return o}))},function(e){app().onError(e)});
  });
 }
 /* After every sign-in the SERVER decides the role (owner / admin / member). */
 function syncRole(user,g,tries){
  call('/api/session','POST',{}).then(function(){
   if(g!==gen)return;
   return user.getIdToken(true);   /* pick up the new role claim */
  },function(e){
   if(g!==gen)return;
   if(e&&(e.code==='temp-expired'||e.code==='owner-claimed')){auth.signOut();if(app().onNotice)app().onNotice(e.code);return}
   if(tries>0)setTimeout(function(){if(g===gen)syncRole(user,g,tries-1)},5000);   /* free server may still be waking up */
   else console.warn('session sync failed',e)
  });
 }
 auth.onAuthStateChanged(function(user){
  stopAll();startPublic();gen++;
  if(!user){app().onSession(null);return}
  var uid=user.uid,g=gen,lastRole=null;
  var timer=setTimeout(function(){if(!sessionSent&&g===gen){sessionSent=true;app().onSession({uid:uid,name:(user.email||'user').split('@')[0],email:user.email,role:'user',rank:'user'})}},9000);
  userUnsub=db.doc('users/'+uid).onSnapshot(function(s){
   var d=s.data();if(!d||g!==gen)return;
   var isAdm=d.role==='admin'||d.role==='owner';
   if(!sessionSent||lastRole!==d.role){
    sessionSent=true;clearTimeout(timer);
    app().onSession({uid:uid,name:d.username||user.email.split('@')[0],email:user.email,role:isAdm?'admin':'user',rank:d.role});
   }
   lastRole=d.role;app().onUserDoc(d);
   attachOrders(user,isAdm,g);
  },function(e){app().onError(e)});
  unsub.push(db.doc('tgLinks/'+uid).onSnapshot(function(s){app().onTgLink(s.exists?s.data():null)}));
  syncRole(user,g,4);
 });
});
})();
