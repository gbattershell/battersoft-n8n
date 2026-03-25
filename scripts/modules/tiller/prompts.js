// scripts/modules/tiller/prompts.js
// All Claude prompt strings for the tiller module.
// No prompt strings should appear in index.js.

function formatTransactionsCSV(transactions) {
  if (transactions.length === 0) return '(no transactions in this period)'
  const header = 'Date | Description | Category | Amount | Account'
  const rows = transactions.map(t =>
    `${t.date instanceof Date ? t.date.toLocaleDateString('en-US') : 'N/A'} | ${t.description} | ${t.category || '(uncategorized)'} | $${t.amount.toFixed(2)} | ${t.account}`
  )
  return [header, ...rows].join('\n')
}

function formatCategoryBudgets(monthByCategory, budgets) {
  const lines = budgets
    .filter(c => c.type === 'Expense' && c.budget > 0)
    .map(c => {
      const spent = Math.abs(monthByCategory[c.name] ?? 0)
      const remaining = c.budget - spent
      return `${c.name}: spent $${spent.toFixed(2)} of $${c.budget.toFixed(2)} budget ($${remaining.toFixed(2)} remaining)`
    })
  return lines.length > 0 ? lines.join('\n') : '(no budgeted categories found)'
}

export function buildQueryPrompt({ question, transactions, categories, today }) {
  const txnData = formatTransactionsCSV(transactions)
  const monthByCategory = transactions.reduce((acc, t) => {
    acc[t.category || '(uncategorized)'] = (acc[t.category || '(uncategorized)'] ?? 0) + t.amount
    return acc
  }, {})
  const budgetData = formatCategoryBudgets(monthByCategory, categories)

  return `You are a personal finance assistant analyzing Tiller budget data. Answer the user's question concisely.

Today's date: ${today}

Transaction data:
${txnData}

Category budgets (monthly):
${budgetData}

User question: "${question}"

Rules:
- Format your response for Telegram using HTML tags (<b>bold</b> for totals, amounts).
- Use $ currency formatting with 2 decimal places.
- Be concise — this is a mobile chat interface.
- If the data doesn't contain enough information to answer, say so clearly.
- Escape &, <, > as &amp; &lt; &gt; in any user-facing text that isn't an HTML tag.
- Do NOT wrap in markdown code blocks. Return plain HTML text only.`
}

export function buildWeeklyDigestPrompt({ weekTransactions, monthByCategory, budgets, uncategorizedCount, today, monthName }) {
  const weekTotal = weekTransactions
    .filter(t => t.amount < 0)
    .reduce((sum, t) => sum + Math.abs(t.amount), 0)

  const categoryLines = budgets
    .filter(c => c.type === 'Expense' && c.budget > 0)
    .map(c => {
      const spent = Math.abs(monthByCategory[c.name] ?? 0)
      const remaining = c.budget - spent
      const pctRemaining = c.budget > 0 ? (remaining / c.budget * 100).toFixed(1) : '100.0'
      return `${c.name} | $${spent.toFixed(2)} | $${c.budget.toFixed(2)} | $${remaining.toFixed(2)} | ${pctRemaining}`
    })
    .join('\n')

  return `Generate a Weekly Spending Digest for Telegram. Use this exact format with HTML tags:

💰 <b>Weekly Spending Digest — ${today}</b>

Total spent this week: <b>$${weekTotal.toFixed(2)}</b>

📊 <b>Budget Status (${monthName})</b>

Then a table of ALL budgeted categories with columns: Category, Spent, Budget, Remaining.
Add emoji after each row:
- 🚨 if the category is OVER budget (remaining is negative)
- ⚠️ if less than 10.0% of budget remaining (PctRemaining < 10.0)
- No emoji if healthy

Category data (Category | Spent | Budget | Remaining | PctRemaining%):
${categoryLines || '(no budgeted categories)'}

After the table, add:
⚠️ = &lt;10.0% remaining · 🚨 = over budget

📋 <b>Uncategorized:</b> ${uncategorizedCount} transactions need review

Rules:
- Use HTML tags for Telegram (<b>, <code>, <pre>).
- Escape &, <, > as &amp; &lt; &gt; in non-tag text.
- Align the table using <pre> tags for monospace.
- Do NOT wrap in markdown code blocks. Return plain HTML text only.`
}

export function buildBudgetCheckPrompt({ monthByCategory, budgets, today, monthName }) {
  const categoryLines = budgets
    .filter(c => c.type === 'Expense' && c.budget > 0)
    .map(c => {
      const spent = Math.abs(monthByCategory[c.name] ?? 0)
      const remaining = c.budget - spent
      return `${c.name}: spent $${spent.toFixed(2)} of $${c.budget.toFixed(2)} ($${remaining.toFixed(2)} remaining)`
    })
    .join('\n')

  return `You are a budget assistant. Give a concise budget status report for ${monthName}.

Today: ${today}

Budget status by category:
${categoryLines || '(no budgeted categories)'}

Rules:
- List each budgeted category with spent/budget/remaining.
- Flag categories that are over budget with 🚨.
- Flag categories with <10% remaining with ⚠️.
- End with a one-sentence overall assessment (e.g., "On track" or "Over budget in 2 categories").
- Format for Telegram using HTML (<b>bold</b> for emphasis).
- Escape &, <, > as &amp; &lt; &gt; in non-tag text.
- Be concise — mobile chat interface.
- Do NOT wrap in markdown code blocks. Return plain HTML text only.`
}
