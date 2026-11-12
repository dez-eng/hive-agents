# smoke_test.py
import os
from dotenv import load_dotenv
load_dotenv()

# ---------- 第 1 级：导入（不需要 key）----------
print("=== L1 导入检查 ===")
import langgraph
from langgraph.graph import StateGraph, START, END
print(f"✅ langgraph {langgraph.__version__ if hasattr(langgraph,'__version__') else ''}")

from langchain_core.messages import HumanMessage
print("✅ langchain-core")

from langchain_deepseek import ChatDeepSeek
print("✅ langchain-deepseek")

from langchain_openai import ChatOpenAI
print("✅ langchain-openai")

# ---------- 第 2 级：调模型（需要 key）----------
print("\n=== L2 API 检查 ===")
assert os.environ.get("DEEPSEEK_API_KEY"), "❌ .env 里没设 DEEPSEEK_API_KEY"
llm = ChatDeepSeek(model="deepseek-chat")
print("模型回复：", llm.invoke("只回复两个字：成功").content)

# ---------- 第 3 级：最小图 ----------
print("\n=== L3 图检查 ===")
from typing import Annotated, TypedDict
from langgraph.graph.message import add_messages

class S(TypedDict):
    messages: Annotated[list, add_messages]

def node(state: S):
    return {"messages": [("ai", "图跑通了")]}

b = StateGraph(S)
b.add_node("n", node)
b.add_edge(START, "n")
b.add_edge("n", END)
app = b.compile()

print("图输出：", app.invoke({"messages": [("user", "hi")]})["messages"][-1].content)

print("\n🎉 环境完全就绪")