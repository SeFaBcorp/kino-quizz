/* KinoQuiz Firebase layer. The web apiKey below is public by design; security comes from firestore.rules + server. */
window.KQ_CONFIG={apiKey:"AIzaSyDLXZCEc69FZf4k0S1G-eARPdFTM6v-IZA",authDomain:"kino-quizz.firebaseapp.com",projectId:"kino-quizz",storageBucket:"kino-quizz.firebasestorage.app",messagingSenderId:"630969836830",appId:"1:630969836830:web:fa000b1503744b486c550f"};
/* URL of your bot/email server (after deploying on Render), no trailing slash */
window.KQ_SERVER="https://YOUR-SERVER.onrender.com";
(function(){
var V='10.12.2',B='https://www.gstatic.com/firebasejs/'+V+'/firebase-';
['app','auth','firestore','storage'].forEach(function(n){document.write('<script src="'+B+n+'-compat.js"><\/script>')});
window.addEventListener('load',function(){
 if(!window.firebase)return;
 firebase.initializeApp(KQ_CONFIG);
 var auth=firebase.auth(),db=firebase.firestore(),F=firebase.firestore.FieldValue,unsub=[],userUnsub=null,sessionSent=false;
 var COLS=['news','cols','products','ranks'];
 function app(){return window.kqApp}
 function call(path,method,body){
  return auth.currentUser.getIdToken().then(function(tk){
   return fetch(KQ_SERVER+path,{method:method||'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer '+tk},body:body?JSON.stringify(body):undefined})
  }).then(function(r){return r.json().then(function(j){if(!r.ok){var e=new Error(j.error||'server');e.code=j.code||'server/error';throw e}return j})})
 }
 function listen(kind,q){unsub.push(q.onSnapshot(function(s){app().onData(kind,s.docs.map(function(d){var o=d.data();o.id=d.id;return o}))},function(e){app().onError(e)}))}
 function stopAll(){unsub.forEach(function(u){u()});unsub=[];if(userUnsub){userUnsub();userUnsub=null}sessionSent=false}
 function startPublic(){COLS.forEach(function(k){listen(k,db.collection(k))});unsub.push(db.doc('settings/main').onSnapshot(function(s){app().onData('settings',s.data()||{})}))}
 var API={on:true,
  signUp:function(email,username,pw){
   var uname=username.toLowerCase();
   return db.doc('usernames/'+uname).get().then(function(d){
    if(d.exists){var e=new Error('taken');e.code='auth/username-taken';throw e}
    return auth.createUserWithEmailAndPassword(email,pw)
   }).then(function(cred){
    var uid=cred.user.uid,b=db.batch();
    b.set(db.doc('usernames/'+uname),{uid:uid});
    b.set(db.doc('users/'+uid),{email:email.toLowerCase(),username:username,role:'user',mustChange:false,createdAt:F.serverTimestamp()});
    return b.commit().catch(function(err){return cred.user.delete().then(function(){var e=new Error('taken');e.code='auth/username-taken';throw e})});
   })
  },
  signIn:function(email,pw){return auth.signInWithEmailAndPassword(email,pw)},
  signOut:function(){return auth.signOut()},
  resetEmail:function(email){return auth.sendPasswordResetEmail(email)},
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
 auth.onAuthStateChanged(function(user){
  stopAll();startPublic();
  if(!user){app().onSession(null);return}
  var uid=user.uid,timer=setTimeout(function(){if(!sessionSent){sessionSent=true;app().onSession({uid:uid,name:(user.email||'user').split('@')[0],email:user.email,role:'user'})}},4000),lastRole=null;
  userUnsub=db.doc('users/'+uid).onSnapshot(function(s){
   var d=s.data();if(!d)return;
   var isAdm=d.role==='admin'||d.role==='owner';
   if(lastRole!==null&&lastRole!==d.role){user.getIdToken(true)}   /* refresh claims after promotion */
   if(!sessionSent||lastRole!==d.role){
    sessionSent=true;clearTimeout(timer);
    app().onSession({uid:uid,name:d.username||user.email.split('@')[0],email:user.email,role:isAdm?'admin':'user',rank:d.role});
   }
   lastRole=d.role;app().onUserDoc(d);
   if(isAdm)listen('orders',db.collection('orders')); else listen('orders',db.collection('orders').where('uid','==',uid));
  },function(e){app().onError(e)});
  unsub.push(db.doc('tgLinks/'+uid).onSnapshot(function(s){app().onTgLink(s.exists?s.data():null)}));
 });
});
})();
