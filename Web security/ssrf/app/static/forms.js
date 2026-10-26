function display(node,value){node.textContent=typeof value==="string"?value:JSON.stringify(value,null,2);}
document.querySelectorAll("form[data-api]").forEach(function(form){
 form.addEventListener("submit",async function(event){
  event.preventDefault();
  const output=document.getElementById(form.dataset.output||"result");
  const button=form.querySelector("button[type=submit]");
  if(button)button.disabled=true;
  display(output,"Выполняется…");
  try{
   const body=Object.fromEntries(new FormData(form));
   if(form.dataset.headerFields){
    body.headers={};
    form.querySelectorAll(".header-row").forEach(function(row){
     const key=row.querySelector("[data-header-name]").value.trim();
     if(key)body.headers[key]=row.querySelector("[data-header-value]").value;
    });
   }
   const response=await fetch(form.dataset.api,{method:"POST",headers:{"Content-Type":"application/json","Accept":"application/json"},body:JSON.stringify(body),credentials:"same-origin"});
   const data=await response.json();display(output,Object.prototype.hasOwnProperty.call(data,"message")?data.message:data);
   if(form.dataset.observe&&response.ok){
    const observed=await fetch(form.dataset.observe,{credentials:"same-origin",cache:"no-store"});
    display(document.getElementById("observation"),await observed.json());
   }
  }catch(error){display(output,"Не удалось выполнить запрос. Проверьте доступность приложения.");}
  finally{if(button)button.disabled=false;}
 });
});
document.querySelectorAll("[data-observe]").forEach(function(button){
 if(button.tagName!=="BUTTON")return;
 button.addEventListener("click",async function(){
  const output=document.getElementById("observation");
  try{const response=await fetch(button.dataset.observe,{credentials:"same-origin",cache:"no-store"});display(output,await response.json());}
  catch(error){display(output,"Сервис наблюдения недоступен.");}
 });
});

document.querySelectorAll("[data-calc-key]").forEach(function(button){
 button.addEventListener("click",function(){
  const input=document.getElementById("expression");
  input.value+=button.dataset.calcKey;
  input.focus();
 });
});
const addHeader=document.getElementById("add-header");
const expression=document.getElementById("expression");
if(expression)expression.form.addEventListener("reset",function(event){
 event.preventDefault();expression.value="";display(document.getElementById("result"),"Ожидается выражение.");expression.focus();
});
if(addHeader)addHeader.addEventListener("click",function(){
 const container=document.getElementById("request-headers");
 const row=document.createElement("div");row.className="header-row";
 [["Имя заголовка","headerName"],["Значение","headerValue"]].forEach(function(item){
  const label=document.createElement("label");label.textContent=item[0];
  const input=document.createElement("input");input.type="text";input.dataset[item[1]]="";
  label.append(input);row.append(label);
 });
 const remove=document.createElement("button");remove.type="button";remove.className="secondary";remove.textContent="Удалить";
 remove.addEventListener("click",function(){row.remove();});row.append(remove);container.append(row);
});
