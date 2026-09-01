const issue=(code,args,path)=>({code,args,path});
const standardMessage=issue=>{const value=issue.args[0];switch(issue.code){case"type":return"Expected "+value;case"required":return"Expected required property";case"literal":return"Expected "+JSON.stringify(value);case"union":return"Expected union";case"integer":return"Expected integer";case"min_value":return"Expected >= "+value;case"max_value":return"Expected <= "+value;case"greater_than":return"Expected > "+value;case"less_than":return"Expected < "+value;case"min_length":return"Expected length >= "+value;case"max_length":return"Expected length <= "+value;case"unknown_key":return"Expected no additional properties";case"never":return"Expected no value";case"invalid_json":return"Invalid JSON"}};
const standardIssue=issue=>({message:standardMessage(issue),path:issue.path});
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value,key);
const codePoints=value=>/[\uD800-\uDFFF]/.test(value)?[...value].length:value.length;
function c0(value){if(value===null||typeof value!=="object"||Array.isArray(value))return false;if(!own(value,"id")||!c1(value["id"]))return false;if(!own(value,"age")||!c2(value["age"]))return false;if(!own(value,"role")||!c3(value["role"]))return false;if(!own(value,"active")||!c6(value["active"]))return false;if(!own(value,"tags")||!c7(value["tags"]))return false;if(!own(value,"profile")||!c9(value["profile"]))return false;if(own(value,"nickname")&&!c12(value["nickname"]))return false;for(const key of Object.keys(value))if(key!=="id"&&key!=="age"&&key!=="role"&&key!=="active"&&key!=="tags"&&key!=="profile"&&key!=="nickname")return false;return true}
function c1(value){if(typeof value!=="string")return false;const length=codePoints(value);return length>=1&&length<=64}
const c2=value=>Number.isInteger(value)&&value>=0&&value<=130;
const c3=value=>value==="admin"||value==="member";
const c4=value=>Object.is(value,"admin");
const c5=value=>Object.is(value,"member");
const c6=value=>typeof value==="boolean";
function c7(value){if(!Array.isArray(value)||value.length<1||value.length>8)return false;for(let index=0;index<value.length;index++)if(!c8(value[index]))return false;return true}
function c8(value){if(typeof value!=="string")return false;const length=codePoints(value);return length>=1&&length<=24}
function c9(value){if(value===null||typeof value!=="object"||Array.isArray(value))return false;if(!own(value,"displayName")||!c10(value["displayName"]))return false;if(!own(value,"score")||!c11(value["score"]))return false;for(const key of Object.keys(value))if(key!=="displayName"&&key!=="score")return false;return true}
function c10(value){if(typeof value!=="string")return false;const length=codePoints(value);return length>=1&&length<=32}
const c11=value=>typeof value==="number"&&Number.isFinite(value)&&value>=0&&value<=1;
const c12=value=>c13(value)||value===null;
function c13(value){if(typeof value!=="string")return false;const length=codePoints(value);return length<=32}
const c14=value=>value===null;
function d0(value,path){if(value===null||typeof value!=="object"||Array.isArray(value))return issue("type",["object"],path);if(!own(value,"id"))return issue("required",[],[...path,"id"]);if(!c1(value["id"]))return d1(value["id"],[...path,"id"]);if(!own(value,"age"))return issue("required",[],[...path,"age"]);if(!c2(value["age"]))return d2(value["age"],[...path,"age"]);if(!own(value,"role"))return issue("required",[],[...path,"role"]);if(!c3(value["role"]))return d3(value["role"],[...path,"role"]);if(!own(value,"active"))return issue("required",[],[...path,"active"]);if(!c6(value["active"]))return d6(value["active"],[...path,"active"]);if(!own(value,"tags"))return issue("required",[],[...path,"tags"]);if(!c7(value["tags"]))return d7(value["tags"],[...path,"tags"]);if(!own(value,"profile"))return issue("required",[],[...path,"profile"]);if(!c9(value["profile"]))return d9(value["profile"],[...path,"profile"]);if(own(value,"nickname")&&!c12(value["nickname"]))return d12(value["nickname"],[...path,"nickname"]);for(const key of Object.keys(value))if(key!=="id"&&key!=="age"&&key!=="role"&&key!=="active"&&key!=="tags"&&key!=="profile"&&key!=="nickname")return issue("unknown_key",[],[...path,key]);}
function d1(value,path){if(typeof value!=="string")return issue("type",["string"],path);if(codePoints(value)<1)return issue("min_length",[1],path);if(codePoints(value)>64)return issue("max_length",[64],path);}
function d2(value,path){if(typeof value!=="number"||!Number.isFinite(value))return issue("type",["finite number"],path);if(!Number.isInteger(value))return issue("integer",[],path);if(!(value>=0))return issue("min_value",[0],path);if(!(value<=130))return issue("max_value",[130],path);}
const d3=(value,path)=>c3(value)?undefined:issue("union",[],path);
const d4=(value,path)=>Object.is(value,"admin")?undefined:issue("literal",["admin"],path);
const d5=(value,path)=>Object.is(value,"member")?undefined:issue("literal",["member"],path);
const d6=(value,path)=>typeof value==="boolean"?undefined:issue("type",["boolean"],path);
function d7(value,path){if(!Array.isArray(value))return issue("type",["array"],path);if(value.length<1)return issue("min_length",[1],path);if(value.length>8)return issue("max_length",[8],path);for(let index=0;index<value.length;index++)if(!c8(value[index]))return d8(value[index],[...path,index])}
function d8(value,path){if(typeof value!=="string")return issue("type",["string"],path);if(codePoints(value)<1)return issue("min_length",[1],path);if(codePoints(value)>24)return issue("max_length",[24],path);}
function d9(value,path){if(value===null||typeof value!=="object"||Array.isArray(value))return issue("type",["object"],path);if(!own(value,"displayName"))return issue("required",[],[...path,"displayName"]);if(!c10(value["displayName"]))return d10(value["displayName"],[...path,"displayName"]);if(!own(value,"score"))return issue("required",[],[...path,"score"]);if(!c11(value["score"]))return d11(value["score"],[...path,"score"]);for(const key of Object.keys(value))if(key!=="displayName"&&key!=="score")return issue("unknown_key",[],[...path,key]);}
function d10(value,path){if(typeof value!=="string")return issue("type",["string"],path);if(codePoints(value)<1)return issue("min_length",[1],path);if(codePoints(value)>32)return issue("max_length",[32],path);}
function d11(value,path){if(typeof value!=="number"||!Number.isFinite(value))return issue("type",["finite number"],path);if(!(value>=0))return issue("min_value",[0],path);if(!(value<=1))return issue("max_value",[1],path);}
const d12=(value,path)=>c12(value)?undefined:issue("union",[],path);
function d13(value,path){if(typeof value!=="string")return issue("type",["string"],path);if(codePoints(value)>32)return issue("max_length",[32],path);}
const d14=(value,path)=>value===null?undefined:issue("type",["null"],path);
export const is=value=>c0(value);
export const validate=value=>c0(value)?{value}:{issues:[d0(value,[])]};
const standardValidate=value=>{const result=validate(value);return result.issues?{issues:[standardIssue(result.issues[0])]}:result};
export const schema={"~standard":{version:1,vendor:"jsimd-validator/aot",validate:standardValidate}};
export default schema;
