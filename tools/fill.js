(()=>{
  const ta = document.querySelector('.chatbot__textarea textarea') || document.querySelector('.chatbot__textarea');
  if(!ta) return 'no textarea';
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype,'value').set;
  setter.call(ta, "帮我在云数据库里新建两个集合：commands 和 devices。建完请明确告诉我：这两个集合的完整名字是什么（有没有带项目 ID 后缀），我用服务端 API Key 通过 HTTP API 访问时应该写哪个集合名。");
  ta.dispatchEvent(new Event('input', {bubbles:true}));
  return 'filled: ' + ta.value.length;
})()