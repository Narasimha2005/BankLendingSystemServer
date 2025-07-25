const express = require('express');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const { open } = require('sqlite');
const sqlite3 = require('sqlite3');
const cors = require('cors');


const app = express();
app.use(express.json());
app.use(cors());

const dbPath = path.join(__dirname, 'bank.db');
let db = null;
const initializeDBAndServer = async () => {
    try {
        db = await open({
            filename: dbPath,
            driver: sqlite3.Database
        });
        app.listen(3000, () => {
            console.log('Server is running on port 3000');
        });
    } catch (error) {
        console.log(`DB Error: ${error.message}`);
        process.exit(1);
    }
};
initializeDBAndServer();


app.get('/api/v1', (req, res) => {
    res.send('Hello World');
});


app.post('/api/v1/loans', async (req, res) => {
    const data = req.body;

    const requiredFields = ["customer_id", "loan_amount", "loan_period_years", "interest_rate_yearly"];
    for (const field of requiredFields) {
        if (!(field in data)) {
            return res.status(400).json({ error: `Missing required field: ${field}` });
        }
    }

    let customerId, loanAmount, loanPeriodYears, interestRateYearly;

    try {
        customerId = String(data.customer_id);
        loanAmount = parseFloat(data.loan_amount);
        loanPeriodYears = parseInt(data.loan_period_years, 10); // Convert to integer using radix 10 means base 10
        interestRateYearly = parseFloat(data.interest_rate_yearly);
    } catch (e) {
        return res.status(400).json({ error: "Invalid data types for one or more fields. Ensure loan_amount, loan_period_years, and interest_rate_yearly are numbers." });
    }

    // Additional validation for positive values
    if (loanAmount <= 0 || loanPeriodYears <= 0 || interestRateYearly < 0) {
        return res.status(400).json({ error: "Loan amount and loan period must be positive. Interest rate cannot be negative." });
    }


    // Total Interest (I) = P * N * (R / 100)
    const totalInterest = loanAmount * loanPeriodYears * (interestRateYearly / 100);

    // Total Amount (A) = P + I
    const totalAmountPayable = loanAmount + totalInterest;

    // Monthly EMI = A / (N * 12)
    let monthlyEmi;
    if (loanPeriodYears === 0) {
        monthlyEmi = 0;
    } else {
        monthlyEmi = totalAmountPayable / (loanPeriodYears * 12);
    }

    const loanId = uuidv4();
    db.run(`INSERT INTO Loans (loan_id, customer_id, principal_amount, total_amount, interest_rate, loan_period_years, monthly_emi, status,created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`, [loanId, customerId, loanAmount, totalAmountPayable, interestRateYearly, loanPeriodYears, monthlyEmi, "ACTIVE", new Date()]);

    // Success Response
    const responseData = {
        loan_id: loanId,
        customer_id: customerId,
        total_amount_payable: parseFloat(totalAmountPayable.toFixed(2)), // Round to 2 decimal places for currency
        monthly_emi: parseFloat(monthlyEmi.toFixed(2)) // Round to 2 decimal places
    };

    return res.status(201).json(responseData);
});

app.post('/api/v1/loans/:loan_id/payments', async (req, res) => {
    const { loan_id } = req.params;
    const { amount, payment_type } = req.body;

    if (payment_type === "EMI") {
        const loan = await db.get(`SELECT * FROM Loans WHERE loan_id = ?`, [loan_id]);
        if (!loan) {
            return res.status(404).json({ error: "Loan not found" });
        }
        if (amount != loan.monthly_emi) {
            return res.status(400).json({ error: "Either change the amount to the monthly EMI or change the payment type to LUMP_SUM" });
        }
        if (loan.status === "PAID_OFF") {
            return res.status(400).json({ error: "Loan is already paid" });
        }
        const paymentId = uuidv4();
        db.run(`INSERT INTO Payments (payment_id, loan_id, amount, payment_type, payment_date) VALUES (?, ?, ?, ?, ?)`, [paymentId, loan_id, amount, payment_type, new Date()]);

        const payments = await db.all(`SELECT * FROM Payments WHERE loan_id = ? AND payment_type = "EMI"`, [loan_id]);
        const totalEmiPaid = payments.reduce((acc, curr) => acc + curr.amount, 0);
        const emisPaid = totalEmiPaid / loan.monthly_emi;

        if (emisPaid == loan.loan_period_years * 12) {
            db.run(`UPDATE Loans SET total_amount = total_amount - ?, status = "PAID_OFF" WHERE loan_id = ?`, [amount, loan_id]);
            return res.status(201).json({ payment_id: paymentId, loan_id: loan_id, message: "Payment recorded successfully.", remaining_amount: loan.total_amount - amount, payment_type: payment_type, emi_left: loan.loan_period_years * 12 - emisPaid });
        }
        db.run(`UPDATE Loans SET total_amount = total_amount - ? WHERE loan_id = ?`, [amount, loan_id]);
        return res.status(201).json({ payment_id: paymentId, loan_id: loan_id, message: "Payment recorded successfully.", remaining_amount: loan.total_amount - amount, payment_type: payment_type, emi_left: loan.loan_period_years * 12 - emisPaid });
    } else if (payment_type === "LUMP_SUM") {
        const loan = await db.get(`SELECT * FROM Loans WHERE loan_id = ?`, [loan_id]);
        if (!loan) {
            return res.status(404).json({ error: "Loan not found" });
        }
        if (loan.status === "PAID_OFF") {
            return res.status(400).json({ error: "Loan is already paid" });
        }
        if (amount > loan.total_amount) {
            return res.status(400).json({ error: "Payment amount is greater than the loan amount" });
        }
        const paymentId = uuidv4();
        db.run(`INSERT INTO Payments (payment_id, loan_id, amount, payment_type, payment_date) VALUES (?, ?, ?, ?, ?)`, [paymentId, loan_id, amount, payment_type, new Date()]);
        const remainingAmount = loan.total_amount - amount;
        const payments = await db.all(`SELECT * FROM Payments WHERE loan_id = ? AND payment_type = "EMI"`, [loan_id]);
        const totalEmiPaid = payments.reduce((acc, curr) => acc + curr.amount, 0);
        const emisPaid = totalEmiPaid / loan.monthly_emi;
        const newEmi = remainingAmount / (loan.loan_period_years * 12 - emisPaid);
        db.run(`UPDATE Loans SET total_amount = ?, monthly_emi = ? WHERE loan_id = ?`, [remainingAmount, newEmi, loan_id]);

        return res.status(201).json({ payment_id: paymentId, loan_id: loan_id, message: "Payment recorded successfully.", remaining_amount: remainingAmount, payment_type: payment_type, emi_left: loan.loan_period_years * 12 - emisPaid });
    }
    return res.status(400).json({ error: "Invalid payment type" });
});

app.get('/api/v1/loans/:loan_id/ledger', async (req, res) => {
    const { loan_id } = req.params;
    const loan = await db.get(`SELECT * FROM Loans WHERE loan_id = ?`, [loan_id]);
    if (!loan) {
        return res.status(404).json({ error: "Loan not found" });
    }
    const ledger = await db.all(`SELECT * FROM Payments WHERE loan_id = ?`, [loan_id]);
    const totalAmount = loan.principal_amount + loan.principal_amount * loan.loan_period_years * (loan.interest_rate / 100)
    
    const payments = await db.all(`SELECT * FROM Payments WHERE loan_id = ?`, [loan.loan_id]);
    const totalAmountPaid = payments.reduce((acc, curr) => acc + curr.amount, 0);

    const responseData = {
        loan_id: loan.loan_id,
        customer_id: loan.customer_id,
        principal: loan.principal_amount,
        total_amount: totalAmount,
        monthly_emi: loan.monthly_emi,
        amount_paid: totalAmountPaid,
        balance_amount: totalAmount - totalAmountPaid,
        transactions: ledger
    };
    return res.status(200).json(responseData);
});

app.get('/api/v1/customers/:customer_id/overview', async (req, res) => {
    const { customer_id } = req.params;
    const customer = await db.get(`SELECT * FROM Customers WHERE customer_id = ?`, [customer_id])
    if (customer === undefined) {
        return res.status(404).json({ error: "Customer Not Found" })
    }
    const loans = await db.all(`SELECT * FROM Loans WHERE customer_id = ?`, [customer_id]);
    const totalLoans = loans.length;
    if (totalLoans === 0) {
        return res.status(404).json({ error: "No Loans Found" })
    }

    for (let i = 0; i < loans.length; i++) {
        const payments = await db.all(`SELECT * FROM Payments WHERE loan_id = ? AND payment_type = "EMI"`, [loans[i].loan_id]);
        const totalEmiPaid = payments.reduce((acc, curr) => acc + curr.amount, 0);
        const emisPaid = totalEmiPaid / loans[i].monthly_emi;
        const emisLeft = loans[i].loan_period_years * 12 - emisPaid;
        loans[i] = { ...loans[i], "emis_left": emisLeft }
    }

    const responseData = {
        customer_id: customer_id,
        total_loans: totalLoans,
        loans: loans
    };
    return res.status(200).json(responseData);
});



// inserting dummy customers
function insertDummyCustomers() {
    const customers = [
        { id: 'cust_001', name: 'Alice Smith' },
        { id: 'cust_002', name: 'Bob Johnson' },
        { id: 'cust_003', name: 'Charlie Brown' }
    ];

    customers.forEach(customer => {
        db.run(`INSERT OR IGNORE INTO Customers (customer_id, name) VALUES (?, ?)`,
            [customer.id, customer.name],
            function (err) {
                if (err) {
                    console.error(`Error inserting customer ${customer.id}:`, err.message);
                } else if (this.changes > 0) {
                    console.log(`Inserted dummy customer: ${customer.name}`);
                }
            }
        );
    });
}

/**
 * Inserts dummy loan data into the Loans table.
 */
function insertDummyLoans() {
    const loans = [
        {
            loan_id: 'loan_001', customer_id: 'cust_001', principal_amount: 10000,
            total_amount: 11000, interest_rate: 10, loan_period_years: 1, monthly_emi: 916.67, status: 'ACTIVE'
        },
        {
            loan_id: 'loan_002', customer_id: 'cust_001', principal_amount: 5000,
            total_amount: 5750, interest_rate: 15, loan_period_years: 1, monthly_emi: 479.17, status: 'ACTIVE'
        },
        {
            loan_id: 'loan_003', customer_id: 'cust_002', principal_amount: 20000,
            total_amount: 24000, interest_rate: 10, loan_period_years: 2, monthly_emi: 1000.00, status: 'ACTIVE'
        }
    ];

    loans.forEach(loan => {
        db.run(`INSERT OR IGNORE INTO Loans (loan_id, customer_id, principal_amount, total_amount, interest_rate, loan_period_years, monthly_emi, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            [loan.loan_id, loan.customer_id, loan.principal_amount, loan.total_amount, loan.interest_rate, loan.loan_period_years, loan.monthly_emi, loan.status],
            function (err) {
                if (err) {
                    console.error(`Error inserting loan ${loan.loan_id}:`, err.message);
                } else if (this.changes > 0) {
                    console.log(`Inserted dummy loan: ${loan.loan_id}`);
                }
            }
        );
    });
}

/**
 * Inserts dummy payment data into the Payments table.
 */
function insertDummyPayments() {
    const payments = [
        { payment_id: uuidv4(), loan_id: 'loan_001', amount: 916.67, payment_type: 'EMI', payment_date: '2025-01-15 10:00:00' },
        { payment_id: uuidv4(), loan_id: 'loan_001', amount: 916.67, payment_type: 'EMI', payment_date: '2025-02-15 10:00:00' },
        { payment_id: uuidv4(), loan_id: 'loan_003', amount: 1000.00, payment_type: 'EMI', payment_date: '2025-03-01 11:00:00' },
        { payment_id: uuidv4(), loan_id: 'loan_003', amount: 5000.00, payment_type: 'LUMP_SUM', payment_date: '2025-04-05 14:30:00' }
    ];

    payments.forEach(payment => {
        db.run(`INSERT OR IGNORE INTO Payments (payment_id, loan_id, amount, payment_type, payment_date) VALUES (?, ?, ?, ?, ?)`,
            [payment.payment_id, payment.loan_id, payment.amount, payment.payment_type, payment.payment_date],
            function (err) {
                if (err) {
                    console.error(`Error inserting payment for loan ${payment.loan_id}:`, err.message);
                } else if (this.changes > 0) {
                    console.log(`Inserted dummy payment: ${payment.payment_id}`);
                }
            }
        );
    });
}

