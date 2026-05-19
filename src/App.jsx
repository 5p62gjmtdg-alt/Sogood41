import React, { useState, useEffect, useRef } from "react";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const BASE_LAT = 47.5936;
const BASE_LNG = 1.3359;
const MAX_KM   = 60;
const MINS_PER_STOP = 8; // minutes estimées par livraison

// 👉 Remplace par ton URL Firebase Realtime Database
const FB = "https://VOTRE-PROJET-default-rtdb.europe-west1.firebasedatabase.app";

// ─── FIREBASE API ─────────────────────────────────────────────────────────────
const api = {
  async get(p)      { try { return (await fetch(`${FB}/${p}.json`)).json(); } catch { return null; } },
  async set(p, d)   { try { await fetch(`${FB}/${p}.json`, { method:"PUT",   body:JSON.stringify(d), headers:{"Content-Type":"application/json"} }); } catch {} },
  async post(p, d)  { try { const r = await fetch(`${FB}/${p}.json`, { method:"POST",  body:JSON.stringify(d), headers:{"Content-Type":"application/json"} }); return (await r.json()).name; } catch { return null; } },
  async patch(p, d) { try { await fetch(`${FB}/${p}.json`, { method:"PATCH", body:JSON.stringify(d), headers:{"Content-Type":"application/json"} }); } catch {} },
  async del(p)      { try { await fetch(`${FB}/${p}.json`, { method:"DELETE" }); } catch {} },
};

function snap2arr(data) {
  if (!data || typeof data !== "object") return [];
  return Object.entries(data).map(([fbKey, v]) => ({ ...v, fbKey }));
}

const local = {
  getMyId:    () => localStorage.getItem("sg-my-id"),
  setMyId:    (id) => localStorage.setItem("sg-my-id", id),
  getMyFbKey: () => localStorage.getItem("sg-fb-key"),
  setMyFbKey: (k)  => localStorage.setItem("sg-fb-key", k),
  clear:      () => { localStorage.removeItem("sg-my-id"); localStorage.removeItem("sg-fb-key"); },
};

// ─── STOCK PAR DÉFAUT ─────────────────────────────────────────────────────────
const DEFAULT_STOCK = [
  { id:"b1", cat:"Burgers",    name:"So Good",         price:10, qty:10 },
  { id:"b2", cat:"Burgers",    name:"Raclette Good",   price:10, qty:10 },
  { id:"b3", cat:"Burgers",    name:"Double Good",     price:7,  qty:10 },
  { id:"b4", cat:"Burgers",    name:"Chèvre Good",     price:8,  qty:10 },
  { id:"s1", cat:"Sandwichs",  name:"Chicken Good",    price:7,  qty:10 },
  { id:"s2", cat:"Sandwichs",  name:"So Classic",      price:8,  qty:10 },
  { id:"s3", cat:"Sandwichs",  name:"So Suisse",       price:8,  qty:10 },
  { id:"s4", cat:"Sandwichs",  name:"So Tex",          price:8,  qty:10 },
  { id:"p1", cat:"Plats",      name:"So Gnogno",       price:10, qty:8  },
  { id:"p2", cat:"Plats",      name:"So Crousty",      price:12, qty:8  },
  { id:"p3", cat:"Plats",      name:"So Lala",         price:12, qty:8  },
  { id:"d1", cat:"Desserts",   name:"Tiramisu Petit",  price:4,  qty:10 },
  { id:"d2", cat:"Desserts",   name:"Tiramisu Grand",  price:7,  qty:10 },
  { id:"d3", cat:"Desserts",   name:"Tarte au Daim",   price:3,  qty:10 },
];

const DAYS = ["Dimanche","Lundi","Mardi","Mercredi","Jeudi","Vendredi","Samedi"];

// ─── GEO ─────────────────────────────────────────────────────────────────────
function haversineKm(lat1, lng1, lat2, lng2) {
  const R=6371, dLat=(lat2-lat1)*Math.PI/180, dLng=(lng2-lng1)*Math.PI/180;
  const a=Math.sin(dLat/2)**2+Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLng/2)**2;
  return R*2*Math.atan2(Math.sqrt(a),Math.sqrt(1-a));
}

function cleanAddress(displayName) {
  const parts = displayName.split(",").map(s=>s.trim());
  const street = parts[0];
  const city   = parts.find(p=>/\b\d{5}\b/.test(p))||parts[1]||"";
  return `${street}, ${city}`.trim().replace(/,\s*$/, "");
}

async function geocode(query) {
  try {
    const url=`https://nominatim.openstreetmap.org/search?format=json&q=${encodeURIComponent(query)}&limit=5&countrycodes=fr`;
    const data=await (await fetch(url,{headers:{"Accept-Language":"fr"}})).json();
    return data.map(r=>({ label:cleanAddress(r.display_name), lat:parseFloat(r.lat), lng:parseFloat(r.lon) }));
  } catch { return []; }
}

function planRoute(clients) {
  const wg=clients.filter(c=>c.lat&&c.lng), ng=clients.filter(c=>!c.lat||!c.lng);
  if(!wg.length) return clients;
  const wd=wg.map(c=>({...c,_d:haversineKm(BASE_LAT,BASE_LNG,c.lat,c.lng)}));
  const cls=[], used=new Set();
  wd.forEach((c,i)=>{
    if(used.has(i)) return;
    const cl=[c]; used.add(i);
    wd.forEach((d,j)=>{ if(!used.has(j)&&haversineKm(c.lat,c.lng,d.lat,d.lng)<3){cl.push(d);used.add(j);} });
    cls.push(cl);
  });
  cls.sort((a,b)=>a.reduce((s,x)=>s+x._d,0)/a.length - b.reduce((s,x)=>s+x._d,0)/b.length);
  return [...cls.flat().map(({_d,...c})=>c), ...ng];
}

// Estime le temps d'attente en minutes
function estimateWait(myPos, queue, truckPos) {
  if (!truckPos || myPos <= 0) return null;
  // Temps = stops avant moi × temps moyen par stop
  const minsDelivery = (myPos - 1) * MINS_PER_STOP;
  return minsDelivery;
}

// ─── HOOK FIREBASE ────────────────────────────────────────────────────────────
function useFirebase() {
  const [queue,  setQueue]  = useState([]);
  const [stock,  setStock]  = useState(DEFAULT_STOCK);
  const [truck,  setTruck]  = useState(null);
  const [ready,  setReady]  = useState(false);

  async function refresh() {
    const [q, s, t] = await Promise.all([api.get("queue"), api.get("stock"), api.get("truck")]);
    setQueue(snap2arr(q));
    setStock(s || DEFAULT_STOCK);
    setTruck(t);
    setReady(true);
  }

  useEffect(() => { refresh(); const t=setInterval(refresh,5000); return ()=>clearInterval(t); }, []);
  return { queue, stock, truck, ready, refresh };
}

// ─── COMPOSANTS UTILITAIRES ───────────────────────────────────────────────────
function AddressLinks({ address }) {
  const enc=encodeURIComponent(address);
  return (
    <div>
      <p style={{color:"#aaa",fontSize:12,margin:"0 0 5px"}}>📍 {address}</p>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
        {[
          {l:"🗺 Waze",        u:`https://waze.com/ul?q=${enc}&navigate=yes`},
          {l:"📍 Google Maps", u:`https://www.google.com/maps/search/?api=1&query=${enc}`},
          {l:"🍎 Plans",       u:`http://maps.apple.com/?q=${enc}`},
        ].map(x=>(
          <a key={x.l} href={x.u} target="_blank" rel="noreferrer"
            style={{padding:"4px 10px",borderRadius:8,background:"#2a2a2a",color:"#FFD600",
              fontSize:11,textDecoration:"none",fontWeight:600,border:"1px solid #333"}}>{x.l}</a>
        ))}
      </div>
    </div>
  );
}

function PhoneLinks({ phone }) {
  return (
    <div style={{display:"flex",gap:6,alignItems:"center",flexWrap:"wrap"}}>
      <span style={{color:"#aaa",fontSize:12}}>📞 {phone}</span>
      <a href={`tel:${phone}`} style={{padding:"3px 10px",borderRadius:8,background:"#1a3a1a",
        color:"#4ade80",fontSize:11,textDecoration:"none",fontWeight:600,border:"1px solid #2a4a2a"}}>📲 Appeler</a>
      <a href={`sms:${phone}`} style={{padding:"3px 10px",borderRadius:8,background:"#1a1a3a",
        color:"#818cf8",fontSize:11,textDecoration:"none",fontWeight:600,border:"1px solid #2a2a4a"}}>💬 SMS</a>
    </div>
  );
}

function CancelButton({ onCancel }) {
  const [c,setC]=useState(false);
  if(c) return (
    <div style={{background:"#2a0000",border:"1.5px solid #f55",borderRadius:14,padding:"16px",marginBottom:8,textAlign:"center"}}>
      <p style={{color:"#fff",fontWeight:700,fontSize:15,margin:"0 0 4px"}}>Annuler ta commande ?</p>
      <p style={{color:"#aaa",fontSize:13,margin:"0 0 14px"}}>Tu perdras ta place dans la file.</p>
      <div style={{display:"flex",gap:10}}>
        <button onClick={()=>setC(false)} style={{flex:1,padding:"12px",borderRadius:10,
          border:"1.5px solid #333",background:"none",color:"#aaa",fontSize:14,cursor:"pointer"}}>Garder</button>
        <button onClick={onCancel} style={{flex:1,padding:"12px",borderRadius:10,border:"none",
          background:"#f55",color:"#fff",fontSize:14,fontWeight:700,cursor:"pointer"}}>Oui, annuler</button>
      </div>
    </div>
  );
  return (
    <button style={{width:"100%",padding:"13px",background:"none",color:"#f55",
      border:"1.5px solid #f55",borderRadius:12,fontSize:14,fontWeight:700,
      cursor:"pointer",marginTop:4,marginBottom:8}} onClick={()=>setC(true)}>
      ✕ Annuler ma commande
    </button>
  );
}

function Header({ subtitle, onSecretTap }) {
  return (
    <div style={{textAlign:"center",padding:"24px 16px 14px",
      background:"linear-gradient(180deg,#FFD600 0%,#111 100%)",
      marginLeft:-16,marginRight:-16,marginBottom:4}}>
      <span style={{fontSize:52,display:"block",lineHeight:1,cursor:"pointer",userSelect:"none"}}
        onClick={onSecretTap}>🐻</span>
      <h1 style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:40,letterSpacing:4,
        color:"#FFD600",textShadow:"0 2px 0 #000",margin:"4px 0 2px"}}>SOGOOD</h1>
      <p style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:11,letterSpacing:3,color:"#111",margin:0}}>
        BLOIS · LOIR-ET-CHER</p>
      {subtitle&&<p style={{color:"#fff",fontSize:13,marginTop:5,opacity:.85}}>{subtitle}</p>}
    </div>
  );
}

function TruckMap({ truckPos }) {
  const ref=useRef(null), mapRef=useRef(null), mkRef=useRef(null);
  useEffect(()=>{
    if(!ref.current||mapRef.current) return;
    const css=document.createElement("link"); css.rel="stylesheet";
    css.href="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css";
    document.head.appendChild(css);
    const js=document.createElement("script");
    js.src="https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js";
    js.onload=()=>{
      const c=truckPos||[BASE_LAT,BASE_LNG];
      mapRef.current=window.L.map(ref.current).setView(c,13);
      window.L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png").addTo(mapRef.current);
      if(truckPos) addMk(truckPos);
    };
    document.head.appendChild(js);
  },[]);
  function addMk(pos){
    if(!mapRef.current||!window.L) return;
    if(mkRef.current) mkRef.current.remove();
    const ic=window.L.divIcon({html:"<div style='font-size:30px'>🚚</div>",className:"",iconAnchor:[15,15]});
    mkRef.current=window.L.marker(pos,{icon:ic}).addTo(mapRef.current).bindPopup("SOGOOD est ici !").openPopup();
    mapRef.current.setView(pos,15);
  }
  useEffect(()=>{ if(truckPos) addMk(truckPos); },[truckPos]);
  return <div ref={ref} style={{height:220,borderRadius:12,overflow:"hidden",border:"2px solid #FFD600",marginTop:10}}/>;
}

// ─── VUE CLIENT ───────────────────────────────────────────────────────────────
function ClientView({ onSecretTap }) {
  const {queue,stock,truck,refresh}=useFirebase();
  const [step,setStep]         = useState(()=>local.getMyId()?"track":"preview");
  const [form,setForm]         = useState({name:"",phone:"",address:"",order:[],comment:""});
  const [errors,setErrors]     = useState({});
  const [loading,setLoading]   = useState(false);
  const [sugg,setSugg]         = useState([]);
  const [addrLoad,setAL]       = useState(false);
  const [addrErr,setAE]        = useState("");
  const [selAddr,setSel]       = useState(null);
  const debRef=useRef(null);
  const myId=local.getMyId();

  function handleAddr(val) {
    setForm(f=>({...f,address:val})); setSel(null); setAE(""); setSugg([]);
    clearTimeout(debRef.current);
    if(val.length<4) return;
    debRef.current=setTimeout(async()=>{ setAL(true); setSugg(await geocode(val)); setAL(false); },600);
  }

  async function selectAddr(s) {
    const km=haversineKm(BASE_LAT,BASE_LNG,s.lat,s.lng);
    if(km>MAX_KM){setAE(`❌ Trop loin (${km.toFixed(0)} km). Max ${MAX_KM} km de Blois.`);setSugg([]);return;}
    setForm(f=>({...f,address:s.label})); setSel({...s,km:km.toFixed(1)}); setSugg([]); setAE("");
  }

  function validate(){
    const e={};
    if(!form.name.trim())    e.name="Obligatoire";
    if(!form.phone.trim())   e.phone="Obligatoire";
    if(!selAddr)             e.address="Sélectionne une adresse dans la liste";
    if(!form.address.trim()) e.address="Obligatoire";
    if(form.order.length===0) e.order="Choisis au moins un produit";
    setErrors(e); return !Object.keys(e).length;
  }

  async function handleSubmit(){
    if(!validate()) return;
    setLoading(true);
    const id=Date.now().toString();
    const day=new Date().getDay(); // 0=dim, 1=lun...
    const entry={id,...form,lat:selAddr?.lat,lng:selAddr?.lng,
      joinedAt:new Date().toISOString(),done:false,day};
    const fbKey=await api.post("queue",entry);
    // Enregistre aussi dans la base clients
    await saveClientRecord(entry);
    local.setMyId(id); local.setMyFbKey(fbKey);
    setLoading(false); refresh(); setStep("track");
  }

  async function saveClientRecord(entry){
    // Cherche si le client existe déjà (par téléphone)
    const clients=await api.get("clients");
    const arr=snap2arr(clients);
    const existing=arr.find(c=>c.phone===entry.phone);
    const dayName=DAYS[entry.day];
    if(existing){
      // Met à jour l'historique
      const history=[...(existing.history||[]),{
        date:entry.joinedAt, order:entry.order, day:dayName, dayNum:entry.day
      }];
      await api.patch(`clients/${existing.fbKey}`,{
        name:entry.name, lastOrder:entry.joinedAt, history
      });
    } else {
      await api.post("clients",{
        name:entry.name, phone:entry.phone, address:entry.address,
        firstOrder:entry.joinedAt, lastOrder:entry.joinedAt,
        history:[{date:entry.joinedAt, order:entry.order, day:dayName, dayNum:entry.day}]
      });
    }
  }

  async function cancelOrder(){
    const fbKey=local.getMyFbKey();
    if(fbKey) await api.del(`queue/${fbKey}`);
    local.clear(); setStep("preview");
    setForm({name:"",phone:"",address:"",order:[],comment:""}); setSel(null); refresh();
  }

  function toggleItem(id){setForm(f=>({...f,order:f.order.includes(id)?f.order.filter(x=>x!==id):[...f.order,id]}));}

  const waiting=queue.filter(c=>!c.done);
  const myIdx=waiting.findIndex(c=>c.id===myId);
  const myPos=myIdx+1;
  const me=queue.find(c=>c.id===myId);
  const waitMins=estimateWait(myPos, waiting, truck);
  const CAT_ICONS={"Burgers":"🍔","Sandwichs":"🥙","Plats":"🍽️","Desserts":"🍮"};
  const CICONS={"Burgers":"🍔","Sandwichs":"🥙","Plats":"🍽️","Desserts":"🍮"};
  const cats=[...new Set(stock.map(s=>s.cat))];

  // ── SUIVI ──
  if(step==="track") return (
    <div>
      <Header onSecretTap={onSecretTap}/>

      {/* Temps d'attente estimé */}
      <div style={{...S.card,background:"linear-gradient(135deg,#FFD600,#ffe94d)",border:"none",marginTop:12}}>
        <p style={{color:"#111",fontSize:11,fontFamily:"'Bebas Neue',sans-serif",letterSpacing:2,margin:"0 0 4px"}}>
          TEMPS D'ATTENTE ESTIMÉ</p>
        {myPos===1?(
          <p style={{fontSize:28,fontWeight:900,color:"#111",margin:"4px 0",fontFamily:"'Bebas Neue',sans-serif",letterSpacing:2}}>
            🎉 C'EST VOTRE TOUR !</p>
        ):(
          <>
            <div style={{display:"flex",alignItems:"baseline",gap:6}}>
              <span style={{fontSize:72,fontFamily:"'Bebas Neue',sans-serif",color:"#111",lineHeight:1}}>
                {waitMins!=null?waitMins:"—"}</span>
              <span style={{color:"rgba(0,0,0,.5)",fontSize:18}}>min</span>
            </div>
            <p style={{color:"#111",fontSize:13,fontWeight:700,marginTop:4}}>
              {myPos>1?`${myPos-1} livraison${myPos>2?"s":""} avant vous`:"Calcul en cours…"}</p>
          </>
        )}
        {!truck&&myPos>1&&(
          <p style={{color:"rgba(0,0,0,.5)",fontSize:11,margin:"4px 0 0"}}>
            ⏱ Estimation basée sur ~{MINS_PER_STOP} min par livraison</p>
        )}
      </div>

      {me?.order?.length>0&&(
        <div style={S.card}>
          <p style={S.label}>🛒 Votre commande</p>
          {me.order.map(id=>{const it=stock.find(s=>s.id===id); return it?(
            <div key={id} style={{display:"flex",justifyContent:"space-between",padding:"4px 0",borderBottom:"1px solid #2a2a2a"}}>
              <span style={{color:"#fff",fontSize:14}}>{it.name}</span>
              <span style={{color:"#FFD600",fontSize:14}}>{it.price}€</span>
            </div>
          ):null;})}
          <div style={{borderTop:"1px solid #333",marginTop:6,paddingTop:6,display:"flex",justifyContent:"space-between"}}>
            <span style={{color:"#aaa",fontSize:13}}>Total</span>
            <span style={{color:"#FFD600",fontFamily:"'Bebas Neue',sans-serif",fontSize:16}}>
              {me.order.reduce((s,id)=>s+(stock.find(x=>x.id===id)?.price||0),0)}€</span>
          </div>
        </div>
      )}

      <div style={S.card}>
        <p style={S.label}>🚚 Le camion en direct</p>
        {truck?<TruckMap truckPos={truck}/>:<div style={S.placeholder}>Position du camion pas encore activée</div>}
      </div>

      {me&&(
        <div style={S.card}>
          <p style={S.label}>Votre fiche</p>
          <p style={{color:"#fff",fontWeight:700,margin:"0 0 4px"}}>{me.name}</p>
          <p style={{color:"#aaa",fontSize:13,margin:"0 0 2px"}}>📞 {me.phone}</p>
          <p style={{color:"#aaa",fontSize:13,margin:0}}>📍 {me.address}</p>
        </div>
      )}

      <CancelButton onCancel={cancelOrder}/>
    </div>
  );

  // ── CONTACT ──
  if(step==="contact") return (
    <div>
      <Header subtitle="Contacte-nous 📲" onSecretTap={onSecretTap}/>
      <div style={{...S.card,marginTop:12}}>
        <p style={S.label}>📲 Nos réseaux</p>
        <a href="https://www.instagram.com/soo.good41" target="_blank" rel="noreferrer"
          style={{display:"flex",alignItems:"center",gap:14,padding:"14px",borderRadius:12,
            background:"linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045)",marginBottom:10,textDecoration:"none"}}>
          <span style={{fontSize:28}}>📸</span>
          <div><p style={{color:"#fff",fontWeight:700,margin:0}}>Instagram</p>
            <p style={{color:"rgba(255,255,255,.8)",margin:0,fontSize:13}}>@soo.good41</p></div>
        </a>
        <a href="https://www.snapchat.com/add/soo.good41" target="_blank" rel="noreferrer"
          style={{display:"flex",alignItems:"center",gap:14,padding:"14px",borderRadius:12,
            background:"#FFFC00",marginBottom:10,textDecoration:"none"}}>
          <span style={{fontSize:28}}>👻</span>
          <div><p style={{color:"#111",fontWeight:700,margin:0}}>Snapchat</p>
            <p style={{color:"#333",margin:0,fontSize:13}}>soo.good41</p></div>
        </a>
        <a href="tel:0781900284"
          style={{display:"flex",alignItems:"center",gap:14,padding:"14px",borderRadius:12,
            background:"#1e1e1e",border:"1.5px solid #FFD600",textDecoration:"none"}}>
          <span style={{fontSize:28}}>📞</span>
          <div><p style={{color:"#fff",fontWeight:700,margin:0}}>Téléphone</p>
            <p style={{color:"#FFD600",margin:0,fontSize:13}}>07.81.90.02.84</p></div>
        </a>
      </div>
    </div>
  );

  // ── PREVIEW ──
  if(step==="preview") return (
    <div>
      <Header subtitle="Rejoins la file pour être livré 🍔" onSecretTap={onSecretTap}/>
      <div style={{...S.card,marginTop:12}}>
        <p style={S.label}>👥 File d'attente</p>
        {waiting.length===0
          ?<p style={{color:"#555",textAlign:"center",padding:"12px 0",margin:0}}>Aucun client — sois le premier !</p>
          :(<>
            <div style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",borderRadius:10,
              background:"#2a2200",border:"1px solid #FFD600",marginBottom:8}}>
              <span style={{fontSize:22}}>⏱</span>
              <div>
                <p style={{color:"#FFD600",fontWeight:700,margin:0,fontFamily:"'Bebas Neue',sans-serif",fontSize:15,letterSpacing:1}}>
                  ~{waiting.length * MINS_PER_STOP} min d'attente actuellement</p>
                <p style={{color:"#aaa",fontSize:12,margin:0}}>{waiting.length} client{waiting.length>1?"s":""} dans la file</p>
              </div>
            </div>
          </>)
        }
      </div>

      <div style={S.card}>
        <p style={S.label}>📦 Menu disponible</p>
        {cats.map(cat=>(
          <div key={cat} style={{marginBottom:10}}>
            <p style={{color:"#FFD600",fontSize:12,fontFamily:"'Bebas Neue',sans-serif",letterSpacing:1,margin:"6px 0 4px"}}>{CICONS?.[cat]||CAT_ICONS?.[cat]||""} {cat}</p>
            {stock.filter(s=>s.cat===cat).map(item=>(
              <div key={item.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                padding:"8px 10px",borderRadius:8,marginBottom:4,
                background:item.qty===0?"#1a0000":"#222",
                border:`1px solid ${item.qty===0?"#3a0000":"#2a2a2a"}`}}>
                <span style={{color:item.qty===0?"#555":"#ddd",fontSize:14,
                  textDecoration:item.qty===0?"line-through":"none"}}>
                  {item.name} <span style={{color:"#FFD600",fontSize:13}}>{item.price}€</span>
                </span>
                {item.qty===0&&(
                  <span style={{fontSize:11,fontWeight:700,color:"#f55",background:"#2a0000",
                    padding:"2px 8px",borderRadius:8,border:"1px solid #5a0000",whiteSpace:"nowrap"}}>
                    🚫 Indisponible</span>
                )}
              </div>
            ))}
          </div>
        ))}
      </div>
      <button style={S.btn} onClick={()=>setStep("form")}>✅ COMMANDER</button>
    </div>
  );

  // ── FORMULAIRE ──
  return (
    <div>
      <Header subtitle="Plus qu'une étape !" onSecretTap={onSecretTap}/>
      <div style={{...S.card,marginTop:12}}>
        <label style={S.label}>Ton prénom / nom *</label>
        <input style={{...S.input,borderColor:errors.name?"#f55":"#333"}}
          value={form.name} placeholder="Ex : Sophie Martin"
          onChange={e=>setForm(f=>({...f,name:e.target.value}))}/>
        {errors.name&&<p style={S.err}>{errors.name}</p>}

        <label style={S.label}>Numéro de téléphone *</label>
        <input style={{...S.input,borderColor:errors.phone?"#f55":"#333"}}
          value={form.phone} placeholder="06 00 00 00 00" type="tel"
          onChange={e=>setForm(f=>({...f,phone:e.target.value}))}/>
        {errors.phone&&<p style={S.err}>{errors.phone}</p>}

        <label style={S.label}>Adresse de livraison *
          <span style={{color:"#555",fontSize:10,letterSpacing:0,fontFamily:"'DM Sans',sans-serif",fontWeight:400}}> (max 60km de Blois)</span>
        </label>
        <input style={{...S.input,borderColor:errors.address?"#f55":selAddr?"#4ade80":"#333"}}
          value={form.address} placeholder="14 Rue Roger Leclerc, Blois"
          onChange={e=>handleAddr(e.target.value)}/>
        {addrLoad&&<p style={{color:"#aaa",fontSize:12,marginTop:-8}}>🔍 Recherche…</p>}
        {addrErr&&<p style={S.err}>{addrErr}</p>}
        {errors.address&&!addrErr&&<p style={S.err}>{errors.address}</p>}
        {selAddr&&(
          <div style={{background:"#1a3a1a",borderRadius:8,padding:"6px 10px",marginBottom:12,border:"1px solid #2a4a2a"}}>
            <p style={{color:"#4ade80",fontSize:12,margin:0}}>✅ {selAddr.km} km de Blois — Confirmée</p>
          </div>
        )}
        {sugg.length>0&&(
          <div style={{background:"#222",borderRadius:10,marginBottom:12,border:"1px solid #333",overflow:"hidden"}}>
            {sugg.map((s,i)=>(
              <button key={i} onClick={()=>selectAddr(s)}
                style={{width:"100%",padding:"10px 12px",background:"none",border:"none",
                  borderBottom:i<sugg.length-1?"1px solid #2a2a2a":"none",
                  color:"#ddd",fontSize:12,cursor:"pointer",textAlign:"left",fontFamily:"'DM Sans',sans-serif"}}>
                📍 {s.label}
              </button>
            ))}
          </div>
        )}

        <label style={S.label}>🛒 Ta commande *
          {errors.order&&<span style={{color:"#f55",fontSize:11}}> — {errors.order}</span>}
        </label>
        {cats.map(cat=>(
          <div key={cat} style={{marginBottom:12}}>
            <p style={{color:"#FFD600",fontSize:11,fontFamily:"'Bebas Neue',sans-serif",letterSpacing:1,margin:"4px 0 6px"}}>{CICONS?.[cat]||CAT_ICONS?.[cat]||""} {cat}</p>
            {stock.filter(s=>s.cat===cat).map(item=>(
              <button key={item.id} disabled={item.qty===0} onClick={()=>item.qty>0&&toggleItem(item.id)}
                style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",
                  padding:"9px 12px",marginBottom:6,borderRadius:10,
                  border:item.qty===0?"1.5px solid #3a0000":form.order.includes(item.id)?"1.5px solid #FFD600":"1.5px solid #2a2a2a",
                  background:item.qty===0?"#1a0000":form.order.includes(item.id)?"#2a2200":"#222",
                  cursor:item.qty===0?"not-allowed":"pointer"}}>
                <span style={{color:item.qty===0?"#555":"#fff",fontSize:14,
                  textDecoration:item.qty===0?"line-through":"none"}}>{item.name}</span>
                <div style={{display:"flex",gap:8,alignItems:"center"}}>
                  {item.qty>0&&<span style={{color:"#FFD600",fontFamily:"'Bebas Neue',sans-serif",fontSize:15}}>{item.price}€</span>}
                  {item.qty===0
                    ?<span style={{fontSize:11,fontWeight:700,color:"#f55",background:"#2a0000",
                      padding:"2px 8px",borderRadius:8,border:"1px solid #5a0000"}}>🚫 Indisponible</span>
                    :form.order.includes(item.id)?<span style={{fontSize:16}}>✅</span>:<span style={{fontSize:16,color:"#555"}}>○</span>
                  }
                </div>
              </button>
            ))}
          </div>
        ))}

        {form.order.length>0&&(
          <div style={{background:"#1a1a00",borderRadius:10,padding:"10px 12px",marginBottom:14}}>
            <p style={{color:"#FFD600",fontSize:12,fontFamily:"'Bebas Neue',sans-serif",letterSpacing:1,margin:"0 0 4px"}}>TOTAL</p>
            <p style={{color:"#fff",fontWeight:700,fontSize:20,margin:0}}>
              {form.order.reduce((s,id)=>s+(stock.find(x=>x.id===id)?.price||0),0)}€</p>
          </div>
        )}

        <label style={S.label}>💬 Commentaire
          <span style={{color:"#555",fontSize:10,letterSpacing:0,fontFamily:"'DM Sans',sans-serif",fontWeight:400}}> (optionnel)</span>
        </label>
        <textarea style={{...S.input,height:80,resize:"none",paddingTop:10}}
          value={form.comment||""}
          placeholder="Ne pas sonner, code portail 1234…"
          onChange={e=>setForm(f=>({...f,comment:e.target.value}))}/>

        <div style={{display:"flex",gap:10}}>
          <button style={{...S.btnOutline,flex:1,marginTop:0}} onClick={()=>setStep("preview")}>← Retour</button>
          <button style={{...S.btn,flex:2,marginTop:0}} onClick={handleSubmit} disabled={loading}>
            {loading?"Envoi…":"REJOINDRE LA FILE"}</button>
        </div>
      </div>
    </div>
  );
}

// ─── VUE ADMIN ────────────────────────────────────────────────────────────────
function AdminView({ onLogout }) {
  const {queue,stock,refresh}=useFirebase();
  const [tab,setTab]=useState("stats");
  const [clients,setClients]=useState([]);
  const [selClient,setSelClient]=useState(null);
  const [searchQ,setSearchQ]=useState("");

  useEffect(()=>{
    async function loadClients(){
      const data=await api.get("clients");
      setClients(snap2arr(data));
    }
    loadClients();
    const t=setInterval(loadClients,10000);
    return ()=>clearInterval(t);
  },[]);

  async function markDone(item){
    if(item.order?.length>0){
      const ns=stock.map(s=>item.order.includes(s.id)?{...s,qty:Math.max(0,s.qty-1)}:s);
      await api.set("stock",ns);
    }
    await api.patch(`queue/${item.fbKey}`,{done:true});
    refresh();
  }

  async function clearDone(){
    const dels=queue.filter(c=>c.done).map(c=>api.del(`queue/${c.fbKey}`));
    await Promise.all(dels); refresh();
  }

  async function resetStock(){
    await api.set("stock",DEFAULT_STOCK); refresh();
  }

  async function updateQty(id,delta){
    const ns=stock.map(s=>s.id===id?{...s,qty:Math.max(0,s.qty+delta)}:s);
    await api.set("stock",ns); refresh();
  }

  // Calcule les stats par jour de semaine
  function computeDayStats(){
    const stats={}; // { productId: { lundi: count, mardi: count, ... } }
    clients.forEach(client=>{
      (client.history||[]).forEach(h=>{
        (h.order||[]).forEach(pid=>{
          if(!stats[pid]) stats[pid]={};
          const day=h.day||DAYS[h.dayNum]||"?";
          stats[pid][day]=(stats[pid][day]||0)+1;
        });
      });
    });
    return stats;
  }

  function computeTopProducts(){
    const totals={};
    clients.forEach(client=>{
      (client.history||[]).forEach(h=>{
        (h.order||[]).forEach(pid=>{
          totals[pid]=(totals[pid]||0)+1;
        });
      });
    });
    return Object.entries(totals)
      .map(([id,count])=>({ id, count, name:DEFAULT_STOCK.find(s=>s.id===id)?.name||id }))
      .sort((a,b)=>b.count-a.count);
  }

  const waiting=queue.filter(c=>!c.done);
  const done=queue.filter(c=>c.done);
  const dayStats=computeDayStats();
  const topProducts=computeTopProducts();
  const CICONS={"Burgers":"🍔","Sandwichs":"🥙","Plats":"🍽️","Desserts":"🍮"};
  const cats=[...new Set(stock.map(s=>s.cat))];
  const filteredClients=clients.filter(c=>
    c.name?.toLowerCase().includes(searchQ.toLowerCase())||
    c.phone?.includes(searchQ)
  );

  return (
    <div>
      <div style={{background:"linear-gradient(135deg,#FFD600,#ffe94d)",borderRadius:16,
        padding:"14px 16px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <p style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:22,color:"#111",letterSpacing:2,margin:0}}>🐻 ADMIN SOGOOD</p>
        <button onClick={onLogout} style={{...S.btnOutline,width:"auto",padding:"8px 14px",marginTop:0,fontSize:13}}>Quitter</button>
      </div>

      {/* Stats rapides */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,marginBottom:12}}>
        {[
          {v:waiting.length,l:"En attente",c:"#FFD600"},
          {v:done.length,l:"Livrés",c:"#4ade80"},
          {v:clients.length,l:"Clients total",c:"#818cf8"},
        ].map(x=>(
          <div key={x.l} style={{...S.card,textAlign:"center",padding:10}}>
            <p style={{fontSize:34,fontFamily:"'Bebas Neue',sans-serif",color:x.c,margin:0}}>{x.v}</p>
            <p style={{color:"#aaa",fontSize:10,margin:0}}>{x.l}</p>
          </div>
        ))}
      </div>

      {/* Tabs */}
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr 1fr",gap:6,marginBottom:12}}>
        {[{k:"stats",l:"📊 Stats"},{k:"clients",l:"👥 Clients"},{k:"queue",l:"📋 File"},{k:"stock",l:"📦 Stock"}].map(t=>(
          <button key={t.k} onClick={()=>setTab(t.k)} style={{padding:"9px 2px",borderRadius:10,border:"none",
            cursor:"pointer",fontFamily:"'Bebas Neue',sans-serif",fontSize:11,letterSpacing:.5,
            background:tab===t.k?"#FFD600":"#1e1e1e",color:tab===t.k?"#111":"#888"}}>{t.l}</button>
        ))}
      </div>

      {/* STATS */}
      {tab==="stats"&&(
        <div>
          <div style={S.card}>
            <p style={S.label}>🏆 TOP PRODUITS (TOUTES PÉRIODES)</p>
            {topProducts.length===0&&<p style={{color:"#555",textAlign:"center",padding:"12px 0",margin:0}}>Pas encore de données</p>}
            {topProducts.slice(0,8).map((p,i)=>(
              <div key={p.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                padding:"8px 0",borderBottom:"1px solid #2a2a2a"}}>
                <div style={{display:"flex",gap:10,alignItems:"center"}}>
                  <span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,
                    color:i===0?"#FFD600":i===1?"#aaa":i===2?"#cd7f32":"#555",minWidth:24}}>#{i+1}</span>
                  <span style={{color:"#fff",fontSize:13}}>{p.name}</span>
                </div>
                <span style={{color:"#FFD600",fontFamily:"'Bebas Neue',sans-serif",fontSize:16}}>{p.count}x</span>
              </div>
            ))}
          </div>

          <div style={S.card}>
            <p style={S.label}>📅 VENTES PAR JOUR DE LA SEMAINE</p>
            {Object.keys(dayStats).length===0&&<p style={{color:"#555",textAlign:"center",padding:"12px 0",margin:0}}>Pas encore de données</p>}
            {Object.entries(dayStats).slice(0,6).map(([pid,days])=>{
              const pName=DEFAULT_STOCK.find(s=>s.id===pid)?.name||pid;
              const sortedDays=Object.entries(days).sort((a,b)=>b[1]-a[1]);
              return (
                <div key={pid} style={{marginBottom:12}}>
                  <p style={{color:"#FFD600",fontSize:12,fontFamily:"'Bebas Neue',sans-serif",
                    letterSpacing:1,margin:"0 0 6px"}}>{pName}</p>
                  {sortedDays.map(([day,count])=>{
                    const max=sortedDays[0][1];
                    return (
                      <div key={day} style={{display:"flex",alignItems:"center",gap:8,marginBottom:4}}>
                        <span style={{color:"#aaa",fontSize:11,minWidth:70}}>{day}</span>
                        <div style={{flex:1,background:"#2a2a2a",borderRadius:4,height:14,overflow:"hidden"}}>
                          <div style={{width:`${(count/max)*100}%`,height:"100%",background:"#FFD600",borderRadius:4}}/>
                        </div>
                        <span style={{color:"#FFD600",fontSize:11,minWidth:20,textAlign:"right"}}>{count}</span>
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* CLIENTS */}
      {tab==="clients"&&(
        <div>
          {selClient?(
            <div style={S.card}>
              <button onClick={()=>setSelClient(null)} style={{...S.btnOutline,width:"auto",padding:"4px 12px",marginTop:0,fontSize:12,marginBottom:12}}>← Retour</button>
              <p style={{color:"#fff",fontWeight:700,fontSize:16,margin:"0 0 2px"}}>{selClient.name}</p>
              <PhoneLinks phone={selClient.phone}/>
              <p style={{color:"#555",fontSize:12,margin:"4px 0 12px"}}>📍 {selClient.address}</p>
              <p style={S.label}>HISTORIQUE DES COMMANDES</p>
              {(selClient.history||[]).slice().reverse().map((h,i)=>(
                <div key={i} style={{background:"#252525",borderRadius:10,padding:"10px",marginBottom:8}}>
                  <div style={{display:"flex",justifyContent:"space-between",marginBottom:6}}>
                    <span style={{color:"#FFD600",fontSize:11,fontFamily:"'Bebas Neue',sans-serif",letterSpacing:1}}>{h.day}</span>
                    <span style={{color:"#555",fontSize:11}}>{new Date(h.date).toLocaleDateString("fr")}</span>
                  </div>
                  {(h.order||[]).map(id=>{
                    const it=DEFAULT_STOCK.find(s=>s.id===id);
                    return it?(<div key={id} style={{display:"flex",justifyContent:"space-between"}}>
                      <span style={{color:"#ddd",fontSize:12}}>{it.name}</span>
                      <span style={{color:"#FFD600",fontSize:12}}>{it.price}€</span>
                    </div>):null;
                  })}
                </div>
              ))}
            </div>
          ):(
            <div style={S.card}>
              <p style={S.label}>👥 BASE CLIENTS ({clients.length})</p>
              <input style={{...S.input,marginBottom:12}} placeholder="Rechercher par nom ou téléphone…"
                value={searchQ} onChange={e=>setSearchQ(e.target.value)}/>
              {filteredClients.length===0&&<p style={{color:"#555",textAlign:"center",padding:"12px 0",margin:0}}>Aucun client trouvé</p>}
              {filteredClients.map(c=>(
                <button key={c.fbKey} onClick={()=>setSelClient(c)}
                  style={{width:"100%",display:"flex",justifyContent:"space-between",alignItems:"center",
                    padding:"10px 0",borderBottom:"1px solid #2a2a2a",background:"none",border:"none",
                    borderBottom:"1px solid #2a2a2a",cursor:"pointer",textAlign:"left"}}>
                  <div>
                    <p style={{color:"#fff",fontWeight:700,margin:0,fontSize:14}}>{c.name}</p>
                    <p style={{color:"#aaa",fontSize:12,margin:0}}>📞 {c.phone} · {(c.history||[]).length} commande{(c.history||[]).length>1?"s":""}</p>
                  </div>
                  <span style={{color:"#FFD600",fontSize:18}}>›</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* FILE */}
      {tab==="queue"&&(
        <div style={S.card}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
            <p style={{...S.label,margin:0}}>FILE D'ATTENTE</p>
            {done.length>0&&<button onClick={clearDone}
              style={{...S.btnOutline,width:"auto",padding:"4px 10px",fontSize:11,marginTop:0}}>Nettoyer</button>}
          </div>
          {waiting.length===0&&<p style={{color:"#555",textAlign:"center",padding:"16px 0",margin:0}}>Aucun client</p>}
          {waiting.map((c,i)=>{
            const total=(c.order||[]).reduce((s,id)=>s+(stock.find(x=>x.id===id)?.price||0),0);
            return (
              <div key={c.fbKey} style={{padding:"12px 0",borderBottom:"1px solid #2a2a2a"}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                  <div style={{display:"flex",gap:10}}>
                    <div style={{width:36,height:36,borderRadius:"50%",flexShrink:0,
                      background:i===0?"#FFD600":"#2a2a2a",color:i===0?"#111":"#888",
                      display:"flex",alignItems:"center",justifyContent:"center",
                      fontFamily:"'Bebas Neue',sans-serif",fontSize:16}}>{i+1}</div>
                    <div>
                      <p style={{color:"#fff",fontWeight:700,margin:"0 0 3px"}}>{c.name}</p>
                      <PhoneLinks phone={c.phone}/>
                      <div style={{marginTop:4}}><AddressLinks address={c.address}/></div>
                    </div>
                  </div>
                  <button onClick={()=>markDone(c)} style={{...S.btn,width:"auto",padding:"8px 12px",
                    fontSize:12,flexShrink:0,marginTop:0}}>✓ Livré</button>
                </div>
                {c.order?.length>0&&(
                  <div style={{marginLeft:46,marginTop:6,background:"#222",borderRadius:8,padding:"6px 10px"}}>
                    <p style={{color:"#FFD600",fontSize:10,fontFamily:"'Bebas Neue',sans-serif",
                      letterSpacing:1,margin:"0 0 4px"}}>COMMANDE — {total}€</p>
                    {c.order.map(id=>{const it=stock.find(s=>s.id===id); return it?(
                      <div key={id} style={{display:"flex",justifyContent:"space-between"}}>
                        <span style={{color:"#ddd",fontSize:12}}>{it.name}</span>
                        <span style={{color:"#FFD600",fontSize:12}}>{it.price}€</span>
                      </div>):null;})}
                  </div>
                )}
                {c.comment&&(
                  <div style={{marginLeft:46,marginTop:6,background:"#1a1a2a",borderRadius:8,
                    padding:"6px 10px",border:"1px solid #2a2a4a"}}>
                    <p style={{color:"#818cf8",fontSize:10,fontFamily:"'Bebas Neue',sans-serif",
                      letterSpacing:1,margin:"0 0 2px"}}>💬 NOTE</p>
                    <p style={{color:"#ddd",fontSize:12,margin:0}}>{c.comment}</p>
                  </div>
                )}
              </div>
            );
          })}
          {done.length>0&&(<>
            <p style={{...S.label,marginTop:16}}>✅ LIVRÉS</p>
            {done.map(c=>(
              <div key={c.fbKey} style={{display:"flex",gap:8,padding:"6px 0",
                borderBottom:"1px solid #222",opacity:.45}}>
                <span>✅</span>
                <div><p style={{color:"#fff",fontWeight:600,margin:0,fontSize:13}}>{c.name}</p>
                  <p style={{color:"#777",fontSize:11,margin:0}}>{c.address}</p></div>
              </div>
            ))}
          </>)}
        </div>
      )}

      {/* STOCK */}
      {tab==="stock"&&(
        <div style={S.card}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
            <p style={{...S.label,margin:0}}>GESTION DU STOCK</p>
            <button onClick={resetStock}
              style={{...S.btnOutline,width:"auto",padding:"4px 10px",fontSize:11,marginTop:0}}>Reset</button>
          </div>
          {cats.map(cat=>(
            <div key={cat} style={{marginBottom:16}}>
              <p style={{color:"#FFD600",fontFamily:"'Bebas Neue',sans-serif",fontSize:13,
                letterSpacing:2,margin:"0 0 8px"}}>{cat}</p>
              {stock.filter(s=>s.cat===cat).map(item=>(
                <div key={item.id} style={{display:"flex",justifyContent:"space-between",
                  alignItems:"center",padding:"8px 0",borderBottom:"1px solid #2a2a2a"}}>
                  <div>
                    <p style={{color:item.qty===0?"#555":"#fff",fontSize:13,margin:"0 0 2px",
                      textDecoration:item.qty===0?"line-through":"none"}}>{item.name}</p>
                    <p style={{color:"#FFD600",fontSize:12,margin:0}}>{item.price}€
                      {item.qty===0&&<span style={{color:"#f55",marginLeft:8,fontSize:11}}>Indisponible</span>}
                    </p>
                  </div>
                  <div style={{display:"flex",alignItems:"center",gap:10}}>
                    <button onClick={()=>updateQty(item.id,-1)}
                      style={{width:32,height:32,borderRadius:"50%",background:"#2a2a2a",
                        border:"none",color:"#fff",fontSize:18,cursor:"pointer"}}>−</button>
                    <span style={{fontSize:18,fontFamily:"'Bebas Neue',sans-serif",minWidth:28,textAlign:"center",
                      color:item.qty>3?"#4ade80":item.qty>0?"#FFD600":"#f55"}}>{item.qty}</span>
                    <button onClick={()=>updateQty(item.id,1)}
                      style={{width:32,height:32,borderRadius:"50%",background:"#FFD600",
                        border:"none",color:"#111",fontSize:18,cursor:"pointer"}}>+</button>
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── VUE LIVREUR ─────────────────────────────────────────────────────────────
function LivreurView({ onLogout }) {
  const {queue,stock,truck,refresh}=useFirebase();
  const [tracking,setTracking]=useState(false);
  const watchId=useRef(null);

  function startTracking(){
    if(!navigator.geolocation) return alert("Géolocalisation non supportée.");
    setTracking(true);
    watchId.current=navigator.geolocation.watchPosition(async pos=>{
      await api.set("truck",[pos.coords.latitude,pos.coords.longitude]);
    },null,{enableHighAccuracy:true});
  }
  function stopTracking(){
    if(watchId.current!=null) navigator.geolocation.clearWatch(watchId.current);
    setTracking(false);
  }
  async function markDone(item){
    if(item.order?.length>0){
      const ns=stock.map(s=>item.order.includes(s.id)?{...s,qty:Math.max(0,s.qty-1)}:s);
      await api.set("stock",ns);
    }
    await api.patch(`queue/${item.fbKey}`,{done:true});
    refresh();
  }

  const waiting=queue.filter(c=>!c.done);
  const planned=planRoute(waiting);
  const done=queue.filter(c=>c.done);

  return (
    <div>
      <div style={{background:"#1e1e1e",border:"1px solid #2a2a2a",borderRadius:16,
        padding:"14px 16px",marginBottom:12,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div>
          <p style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:20,color:"#FFD600",letterSpacing:2,margin:0}}>🚚 LIVREUR SOGOOD</p>
          <p style={{color:tracking?"#4ade80":"#666",fontSize:12,margin:0}}>{tracking?"🟢 GPS actif — clients voient ta position":"⚫ GPS inactif"}</p>
        </div>
        <div style={{display:"flex",gap:8}}>
          <button onClick={tracking?stopTracking:startTracking}
            style={{...S.btn,width:"auto",padding:"8px 14px",marginTop:0,
              background:tracking?"#4ade80":"#FFD600",fontSize:13}}>
            {tracking?"⏹ Stop":"📡 GPS"}</button>
          <button onClick={onLogout} style={{...S.btnOutline,width:"auto",padding:"8px 12px",marginTop:0,fontSize:12}}>Quitter</button>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
        <div style={{...S.card,textAlign:"center",padding:12}}>
          <p style={{fontSize:42,fontFamily:"'Bebas Neue',sans-serif",color:"#FFD600",margin:0}}>{planned.length}</p>
          <p style={{color:"#aaa",fontSize:12,margin:0}}>À livrer</p>
        </div>
        <div style={{...S.card,textAlign:"center",padding:12}}>
          <p style={{fontSize:42,fontFamily:"'Bebas Neue',sans-serif",color:"#4ade80",margin:0}}>{done.length}</p>
          <p style={{color:"#aaa",fontSize:12,margin:0}}>Livrés</p>
        </div>
      </div>

      {truck&&<div style={S.card}><p style={S.label}>Ta position</p><TruckMap truckPos={truck}/></div>}

      <div style={S.card}>
        <p style={S.label}>🗺 TOURNÉE OPTIMISÉE</p>
        <p style={{color:"#555",fontSize:11,margin:"0 0 10px"}}>Regroupées par zone · proche → loin de Blois</p>
        {planned.length===0&&<p style={{color:"#555",textAlign:"center",padding:"16px 0",margin:0}}>Aucune livraison 🎉</p>}
        {planned.map((c,i)=>{
          const total=(c.order||[]).reduce((s,id)=>s+(stock.find(x=>x.id===id)?.price||0),0);
          const isNear=i>0&&c.lat&&planned[i-1]?.lat&&haversineKm(c.lat,c.lng,planned[i-1].lat,planned[i-1].lng)<3;
          return (
            <div key={c.fbKey||i}>
              {isNear&&(
                <div style={{display:"flex",alignItems:"center",gap:6,margin:"4px 0"}}>
                  <div style={{height:1,flex:1,background:"#333"}}/>
                  <span style={{fontSize:10,color:"#FFD600",fontFamily:"'Bebas Neue',sans-serif",letterSpacing:1}}>MÊME ZONE</span>
                  <div style={{height:1,flex:1,background:"#333"}}/>
                </div>
              )}
              <div style={{background:"#252525",borderRadius:12,padding:"12px",marginBottom:8,
                border:`1px solid ${i===0?"#FFD600":"#2a2a2a"}`}}>
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:8}}>
                  <div style={{display:"flex",gap:10}}>
                    <div style={{width:34,height:34,borderRadius:"50%",flexShrink:0,
                      background:i===0?"#FFD600":"#2a2a2a",color:i===0?"#111":"#888",
                      display:"flex",alignItems:"center",justifyContent:"center",
                      fontFamily:"'Bebas Neue',sans-serif",fontSize:16}}>{i+1}</div>
                    <p style={{color:"#fff",fontWeight:700,margin:0,fontSize:15,paddingTop:6}}>{c.name}</p>
                  </div>
                  {total>0&&<span style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:18,color:"#FFD600"}}>{total}€</span>}
                </div>
                <div style={{marginBottom:8}}><PhoneLinks phone={c.phone}/></div>
                <div style={{marginBottom:8}}><AddressLinks address={c.address}/></div>
                {c.order?.length>0&&(
                  <div style={{background:"#1e1e1e",borderRadius:8,padding:"8px 10px",marginBottom:8}}>
                    <p style={{color:"#FFD600",fontSize:10,fontFamily:"'Bebas Neue',sans-serif",letterSpacing:1,margin:"0 0 4px"}}>COMMANDE</p>
                    {c.order.map(id=>{const it=stock.find(s=>s.id===id); return it?(
                      <div key={id} style={{display:"flex",justifyContent:"space-between"}}>
                        <span style={{color:"#ddd",fontSize:12}}>{it.name}</span>
                        <span style={{color:"#FFD600",fontSize:12}}>{it.price}€</span>
                      </div>):null;})}
                  </div>
                )}
                {c.comment&&(
                  <div style={{background:"#1a1a2a",borderRadius:8,padding:"6px 10px",
                    border:"1px solid #2a2a4a",marginBottom:8}}>
                    <p style={{color:"#818cf8",fontSize:10,fontFamily:"'Bebas Neue',sans-serif",
                      letterSpacing:1,margin:"0 0 2px"}}>💬 NOTE CLIENT</p>
                    <p style={{color:"#ddd",fontSize:12,margin:0}}>{c.comment}</p>
                  </div>
                )}
                <button onClick={()=>markDone(c)} style={{...S.btn,marginTop:0,padding:"10px"}}>
                  ✓ Marquer comme livré</button>
              </div>
            </div>
          );
        })}
        {done.length>0&&(
          <div style={{marginTop:16}}>
            <p style={{...S.label}}>✅ LIVRÉS</p>
            {done.map(c=>(
              <div key={c.fbKey} style={{display:"flex",gap:8,padding:"6px 0",
                borderBottom:"1px solid #222",opacity:.45}}>
                <span>✅</span>
                <div><p style={{color:"#fff",fontWeight:600,margin:0,fontSize:13}}>{c.name}</p>
                  <p style={{color:"#777",fontSize:11,margin:0}}>{c.address}</p></div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── LOGIN SECRET ─────────────────────────────────────────────────────────────
function SecretLogin({ onAdmin, onLivreur, onBack }) {
  const [mode,setMode]=useState("choice");
  const [pwd,setPwd]=useState("");
  const [err,setErr]=useState(false);

  function tryLogin(){
    if(mode==="admin"&&pwd==="camion2024"){onAdmin();return;}
    if(mode==="livreur"&&pwd==="livreur2024"){onLivreur();return;}
    setErr(true);
  }

  if(mode==="choice") return (
    <div style={{textAlign:"center",paddingTop:60}}>
      <span style={{fontSize:64}}>🐻</span>
      <h2 style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:30,color:"#FFD600",letterSpacing:3,margin:"8px 0 24px"}}>ACCÈS PRIVÉ</h2>
      <div style={{display:"flex",flexDirection:"column",gap:12,maxWidth:340,margin:"0 auto"}}>
        <button onClick={()=>setMode("admin")} style={{...S.btn,marginTop:0}}>🔐 Accès Admin</button>
        <button onClick={()=>setMode("livreur")} style={{...S.btn,marginTop:0,background:"#1e1e1e",color:"#FFD600",border:"1.5px solid #FFD600"}}>🚚 Accès Livreur</button>
        <button onClick={onBack} style={{...S.btnOutline,marginTop:0}}>← Retour</button>
      </div>
    </div>
  );

  return (
    <div style={{textAlign:"center",paddingTop:60}}>
      <span style={{fontSize:48}}>{mode==="admin"?"🔐":"🚚"}</span>
      <h2 style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:26,color:"#FFD600",letterSpacing:3,margin:"8px 0 20px"}}>
        {mode==="admin"?"MODE ADMIN":"MODE LIVREUR"}</h2>
      <div style={{...S.card,maxWidth:340,margin:"0 auto"}}>
        <label style={S.label}>Mot de passe</label>
        <input type="password" style={S.input} value={pwd} placeholder="••••••••"
          onChange={e=>{setPwd(e.target.value);setErr(false);}}
          onKeyDown={e=>e.key==="Enter"&&tryLogin()}/>
        {err&&<p style={S.err}>Mot de passe incorrect</p>}
        <button style={S.btn} onClick={tryLogin}>CONNEXION</button>
        <button onClick={()=>{setMode("choice");setPwd("");setErr(false);}}
          style={{...S.btnOutline,marginTop:8}}>← Retour</button>
      </div>
    </div>
  );
}

// ─── APP ROOT ─────────────────────────────────────────────────────────────────
class ErrorBoundary extends React.Component {
  constructor(props) { super(props); this.state = { hasError:false }; }
  static getDerivedStateFromError() { return { hasError:true }; }
  render() {
    if(this.state.hasError) return (
      <div style={{background:"#111",minHeight:"100vh",display:"flex",alignItems:"center",
        justifyContent:"center",flexDirection:"column",padding:24}}>
        <span style={{fontSize:64}}>🐻</span>
        <p style={{color:"#FFD600",fontFamily:"sans-serif",fontSize:22,fontWeight:"bold",margin:"12px 0 4px"}}>SOGOOD</p>
        <p style={{color:"#aaa",fontFamily:"sans-serif",fontSize:14,textAlign:"center"}}>
          Une erreur est survenue. Recharge la page.</p>
      </div>
    );
    return this.props.children;
  }
}

function AppInner() {
  const [view,setView]           = useState("client");
  const [clientTab,setClientTab] = useState("preview");
  const [tapCount,setTapCount]   = useState(0);
  const tapTimer = useRef(null);

  useEffect(()=>{
    const l=document.createElement("link");
    l.href="https://fonts.googleapis.com/css2?family=Bebas+Neue&family=DM+Sans:wght@400;500;700&display=swap";
    l.rel="stylesheet"; document.head.appendChild(l);
  },[]);

  function handleSecretTap(){
    const n=tapCount+1; setTapCount(n);
    clearTimeout(tapTimer.current);
    if(n>=5){setTapCount(0);setView("secret");}
    else tapTimer.current=setTimeout(()=>setTapCount(0),2000);
  }

  const miniHeader=(icon)=>(
    <div style={{background:"linear-gradient(180deg,#FFD600 0%,#111 60%)",textAlign:"center",
      padding:"20px 16px 12px",marginLeft:-16,marginRight:-16,marginBottom:8}}>
      <span style={{fontSize:40}}>{icon}</span>
      <p style={{fontFamily:"'Bebas Neue',sans-serif",fontSize:32,color:"#FFD600",
        letterSpacing:4,margin:"2px 0 0",textShadow:"0 2px 0 #000"}}>SOGOOD</p>
    </div>
  );

  if(view==="secret") return <div style={S.page}><SecretLogin onAdmin={()=>setView("admin")} onLivreur={()=>setView("livreur")} onBack={()=>setView("client")}/></div>;
  if(view==="admin")   return <div style={S.page}>{miniHeader("🐻")}<AdminView   onLogout={()=>setView("client")}/></div>;
  if(view==="livreur") return <div style={S.page}>{miniHeader("🚚")}<LivreurView onLogout={()=>setView("client")}/></div>;

  return (
    <div style={{...S.page,paddingBottom:72}}>
      {clientTab==="preview"&&<ClientView onSecretTap={handleSecretTap}/>}
      {clientTab==="contact"&&(
        <div>
          <Header subtitle="Contacte-nous 📲" onSecretTap={handleSecretTap}/>
          <div style={{...S.card,marginTop:12}}>
            <p style={S.label}>📲 Nos réseaux</p>
            <a href="https://www.instagram.com/soo.good41" target="_blank" rel="noreferrer"
              style={{display:"flex",alignItems:"center",gap:14,padding:"14px",borderRadius:12,
                background:"linear-gradient(135deg,#833ab4,#fd1d1d,#fcb045)",marginBottom:10,textDecoration:"none"}}>
              <span style={{fontSize:28}}>📸</span>
              <div><p style={{color:"#fff",fontWeight:700,margin:0}}>Instagram</p>
                <p style={{color:"rgba(255,255,255,.8)",margin:0,fontSize:13}}>@soo.good41</p></div>
            </a>
            <a href="https://www.snapchat.com/add/soo.good41" target="_blank" rel="noreferrer"
              style={{display:"flex",alignItems:"center",gap:14,padding:"14px",borderRadius:12,
                background:"#FFFC00",marginBottom:10,textDecoration:"none"}}>
              <span style={{fontSize:28}}>👻</span>
              <div><p style={{color:"#111",fontWeight:700,margin:0}}>Snapchat</p>
                <p style={{color:"#333",margin:0,fontSize:13}}>soo.good41</p></div>
            </a>
            <a href="tel:0781900284"
              style={{display:"flex",alignItems:"center",gap:14,padding:"14px",borderRadius:12,
                background:"#1e1e1e",border:"1.5px solid #FFD600",textDecoration:"none"}}>
              <span style={{fontSize:28}}>📞</span>
              <div><p style={{color:"#fff",fontWeight:700,margin:0}}>Téléphone</p>
                <p style={{color:"#FFD600",margin:0,fontSize:13}}>07.81.90.02.84</p></div>
            </a>
          </div>
        </div>
      )}
      <div style={{position:"fixed",bottom:0,left:"50%",transform:"translateX(-50%)",
        width:"100%",maxWidth:480,background:"#1a1a1a",borderTop:"1px solid #2a2a2a",
        display:"flex",zIndex:100}}>
        {[{k:"preview",i:"🏠",l:"Accueil"},{k:"contact",i:"📲",l:"Contact"}].map(n=>(
          <button key={n.k} onClick={()=>setClientTab(n.k)}
            style={{flex:1,padding:"10px 0",background:"none",border:"none",cursor:"pointer",
              display:"flex",flexDirection:"column",alignItems:"center",gap:2}}>
            <span style={{fontSize:22}}>{n.i}</span>
            <span style={{fontSize:10,fontFamily:"'Bebas Neue',sans-serif",letterSpacing:1,
              color:clientTab===n.k?"#FFD600":"#555"}}>{n.l}</span>
          </button>
        ))}
      </div>
    </div>
  );
}

const S={
  page:{maxWidth:480,margin:"0 auto",padding:"0 16px 24px",fontFamily:"'DM Sans',sans-serif",background:"#111",minHeight:"100vh"},
  card:{background:"#1e1e1e",borderRadius:16,padding:"16px 14px",marginBottom:12,border:"1px solid #2a2a2a"},
  label:{fontFamily:"'Bebas Neue',sans-serif",fontSize:12,letterSpacing:2,color:"#FFD600",marginBottom:8,display:"block"},
  input:{width:"100%",padding:"12px 14px",borderRadius:10,border:"1.5px solid #333",fontSize:15,marginBottom:12,
    outline:"none",fontFamily:"'DM Sans',sans-serif",boxSizing:"border-box",background:"#111",color:"#fff"},
  btn:{width:"100%",padding:"14px",background:"#FFD600",color:"#111",border:"none",borderRadius:12,fontSize:15,
    fontWeight:700,fontFamily:"'Bebas Neue',sans-serif",letterSpacing:2,cursor:"pointer",marginTop:4},
  btnOutline:{width:"100%",padding:"11px 16px",background:"none",border:"1.5px solid #333",borderRadius:10,
    fontSize:14,cursor:"pointer",fontFamily:"'DM Sans',sans-serif",color:"#aaa",marginTop:8},
  err:{color:"#f55",fontSize:12,marginTop:-8,marginBottom:10},
  placeholder:{height:80,display:"flex",alignItems:"center",justifyContent:"center",
    background:"#111",borderRadius:10,color:"#555",fontSize:13},
};


export default function App() {
  return <ErrorBoundary><AppInner/></ErrorBoundary>;
}
