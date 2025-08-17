// Enhanced POS Invoice JavaScript with Complete M-Pesa Integration
frappe.ui.form.on("POS Invoice", {
    refresh: function(frm) {
        // Create enhanced M-Pesa payment interface
        setTimeout(() => {
            create_mpesa_payment_interface(frm);
        }, 500);
    },
});

// Global variables to track payment state
let current_payment_dialog = null;
let payment_polling_interval = null;
let checkout_request_id = null;

function create_mpesa_payment_interface(frm) {
    const payments_wrapper = document.querySelector('.payment-modes');
    if (!payments_wrapper || document.querySelector('.mpesa-payment-section')) return;

    // Create M-Pesa payment section
    const mpesaSection = document.createElement('div');
    mpesaSection.className = 'mpesa-payment-section';
    mpesaSection.style.marginTop = '10px';
    mpesaSection.style.padding = '10px';
    mpesaSection.style.border = '1px solid #ddd';
    mpesaSection.style.borderRadius = '5px';
    mpesaSection.style.backgroundColor = '#f9f9f9';

    mpesaSection.innerHTML = `
        <div class="mpesa-header" style="margin-bottom: 10px;">
            <h5 style="margin: 0; color: #2c5aa0;">M-Pesa Payment Options</h5>
        </div>
        <div class="mpesa-buttons" style="display: flex; gap: 10px; flex-wrap: wrap;">
            <button class="btn btn-success btn-sm btn-mpesa-full">
                <i class="fa fa-mobile"></i> Pay Full Amount (M-Pesa)
            </button>
            <button class="btn btn-primary btn-sm btn-mpesa-partial">
                <i class="fa fa-money"></i> Mixed Payment (Cash + M-Pesa)
            </button>
            <button class="btn btn-warning btn-sm btn-mpesa-status" style="display: none;">
                <i class="fa fa-clock-o"></i> Check Payment Status
            </button>
        </div>
        <div class="mpesa-status" style="margin-top: 10px; display: none;">
            <div class="alert alert-info" style="margin: 0;">
                <strong>Payment Status:</strong> <span class="status-text">Waiting for payment...</span>
            </div>
        </div>
    `;

    payments_wrapper.appendChild(mpesaSection);

    // Attach event listeners
    setup_mpesa_event_listeners(frm, mpesaSection);
}

function setup_mpesa_event_listeners(frm, mpesaSection) {
    // Full M-Pesa payment
    mpesaSection.querySelector('.btn-mpesa-full').addEventListener('click', function() {
        initiate_mpesa_payment(frm, frm.doc.grand_total, 'full');
    });

    // Mixed payment (Cash + M-Pesa)
    mpesaSection.querySelector('.btn-mpesa-partial').addEventListener('click', function() {
        show_mixed_payment_dialog(frm);
    });

    // Check payment status
    mpesaSection.querySelector('.btn-mpesa-status').addEventListener('click', function() {
        if (checkout_request_id) {
            check_payment_status_manually(frm, checkout_request_id);
        }
    });
}

function show_mixed_payment_dialog(frm) {
    const total_amount = frm.doc.grand_total;

    const d = new frappe.ui.Dialog({
        title: __('Mixed Payment (Cash + M-Pesa)'),
        fields: [
            {
                label: __('Total Amount'),
                fieldname: 'total_amount',
                fieldtype: 'Currency',
                default: total_amount,
                read_only: 1
            },
            {
                label: __('Cash Amount'),
                fieldname: 'cash_amount',
                fieldtype: 'Currency',
                default: 0,
                description: 'Amount to be paid in cash'
            },
            {
                label: __('M-Pesa Amount'),
                fieldname: 'mpesa_amount',
                fieldtype: 'Currency',
                default: total_amount,
                read_only: 1,
                description: 'Amount to be paid via M-Pesa'
            },
            {
                label: __('Customer Phone Number'),
                fieldname: 'phone_number',
                fieldtype: 'Data',
                reqd: 1,
                description: 'Enter customer\'s M-Pesa registered phone number (e.g., 2547XXXXXXXX)'
            }
        ],
        primary_action_label: __('Proceed with Mixed Payment'),
        primary_action: function(values) {
            if (values.cash_amount + values.mpesa_amount !== total_amount) {
                frappe.show_alert({
                    message: __('Cash + M-Pesa amounts must equal total amount'),
                    indicator: 'red'
                });
                return;
            }

            if (values.mpesa_amount <= 0) {
                frappe.show_alert({
                    message: __('M-Pesa amount must be greater than 0'),
                    indicator: 'red'
                });
                return;
            }

            d.hide();
            setup_mixed_payment(frm, values.cash_amount, values.mpesa_amount, values.phone_number);
        }
    });

    // Auto-calculate M-Pesa amount when cash amount changes
    d.fields_dict.cash_amount.$input.on('input', function() {
        const cash_amount = parseFloat(this.value) || 0;
        const mpesa_amount = Math.max(0, total_amount - cash_amount);
        d.set_value('mpesa_amount', mpesa_amount);
    });

    d.show();
}

function setup_mixed_payment(frm, cash_amount, mpesa_amount, phone_number) {
    // Clear existing payments and add both cash and M-Pesa
    frm.doc.payments = [];

    if (cash_amount > 0) {
        frm.add_child('payments', {
            mode_of_payment: "Cash",
            amount: cash_amount,
            base_amount: cash_amount
        });
    }

    frm.add_child('payments', {
        mode_of_payment: "M-Pesa Express",
        amount: mpesa_amount,
        base_amount: mpesa_amount,
        account: 'M-Pesa Express - TS'
    });

    frm.set_value("paid_amount", frm.doc.grand_total);
    frm.refresh_field("payments");

    // Save and initiate M-Pesa for the M-Pesa portion
    save_and_initiate_mpesa(frm, phone_number, mpesa_amount, 'mixed');
}

function initiate_mpesa_payment(frm, amount, payment_type) {
    if (!amount || amount === 0) {
        frappe.show_alert({
            message: __('Please add items to the cart first.'),
            indicator: 'red'
        });
        return;
    }

    if (frm.doc.docstatus === 1) {
        frappe.show_alert({
            message: __('Invoice is already submitted.'),
            indicator: 'orange'
        });
        return;
    }

    const d = new frappe.ui.Dialog({
        title: __('M-Pesa Express Payment'),
        fields: [{
            label: __('Phone Number'),
            fieldname: 'phone_number',
            fieldtype: 'Data',
            reqd: 1,
            description: 'Enter customer\'s M-Pesa registered phone number (e.g., 2547XXXXXXXX)'
        }],
        primary_action_label: __('Initiate STK Push'),
        primary_action: function(values) {
            d.hide();

            if (payment_type === 'full') {
                // Setup full M-Pesa payment
                frm.doc.payments = frm.doc.payments.filter(p => p.mode_of_payment !== "Cash");
                const payment_exists = frm.doc.payments.some(p => p.mode_of_payment === "M-Pesa Express");
                if (!payment_exists) {
                    frm.add_child('payments', {
                        mode_of_payment: "M-Pesa Express",
                        amount: amount,
                        base_amount: amount,
                        account: 'M-Pesa Express - TS'
                    });
                }
                frm.set_value("paid_amount", amount);
                frm.refresh_field("payments");
            }

            save_and_initiate_mpesa(frm, values.phone_number, amount, payment_type);
        }
    });
    d.show();
}

function save_and_initiate_mpesa(frm, phone_number, amount, payment_type) {
    frappe.dom.freeze(__('Saving POS Invoice...'));

    frm.save().then(() => {
        verify_pos_invoice_and_initiate(frm, phone_number, amount, payment_type, 0);
    }).catch(err => {
        frappe.dom.unfreeze();
        frappe.show_alert({
            message: __('Failed to save POS Invoice: ') + (err.message || 'Unknown error'),
            indicator: 'red'
        });
        console.error('Save error:', err);
    });
}

function verify_pos_invoice_and_initiate(frm, phone_number, amount, payment_type, retry_count) {
    const max_retries = 5;
    const retry_delay = 1000;

    if (retry_count >= max_retries) {
        frappe.dom.unfreeze();
        frappe.show_alert({
            message: __('Failed to save POS Invoice after multiple attempts. Please try again.'),
            indicator: 'red'
        });
        return;
    }

    frappe.call({
        method: "frappe.client.get_value",
        args: {
            doctype: "POS Invoice",
            filters: { name: frm.doc.name },
            fieldname: ["name", "docstatus"]
        },
        callback: function(r) {
            if (r.message && r.message.name) {
                frappe.dom.unfreeze();
                frappe.show_alert({
                    message: __('POS Invoice saved successfully. Initiating M-Pesa payment...'),
                    indicator: 'blue'
                });
                show_enhanced_payment_dialog(frm, phone_number, amount, payment_type);
            } else {
                console.log(`Retry ${retry_count + 1}/${max_retries}: POS Invoice ${frm.doc.name} not found`);
                setTimeout(() => {
                    verify_pos_invoice_and_initiate(frm, phone_number, amount, payment_type, retry_count + 1);
                }, retry_delay);
            }
        },
        error: function(err) {
            console.log(`Retry ${retry_count + 1}/${max_retries}: Error checking POS Invoice:`, err);
            setTimeout(() => {
                verify_pos_invoice_and_initiate(frm, phone_number, amount, payment_type, retry_count + 1);
            }, retry_delay);
        }
    });
}

function show_enhanced_payment_dialog(frm, phone_number, amount, payment_type) {
    // Close any existing payment dialog
    if (current_payment_dialog) {
        current_payment_dialog.hide();
    }

    current_payment_dialog = new frappe.ui.Dialog({
        title: __('M-Pesa Payment Status'),
        size: 'small',
        fields: [{
            fieldtype: 'HTML',
            fieldname: 'payment_status',
            options: `
                <div class="text-center payment-status-container">
                    <div class="payment-loading" style="margin-bottom: 20px;">
                        <img src="/assets/frappe/images/ui/spinner.gif" style="width: 50px; margin-bottom: 15px;">
                        <h4 style="color: #2c5aa0;">Initiating M-Pesa STK Push...</h4>
                        <p style="color: #666;">Amount: KES ${amount.toLocaleString()}</p>
                        <p style="color: #666;">Phone: ${phone_number}</p>
                    </div>
                    <div class="payment-actions" style="margin-top: 20px;">
                        <button class="btn btn-warning btn-sm btn-retry-payment" style="display: none; margin-right: 10px;">
                            <i class="fa fa-refresh"></i> Retry Payment
                        </button>
                        <button class="btn btn-secondary btn-sm btn-switch-cash" style="display: none; margin-right: 10px;">
                            <i class="fa fa-money"></i> Switch to Cash
                        </button>
                        <button class="btn btn-danger btn-sm btn-cancel-payment">
                            <i class="fa fa-times"></i> Cancel
                        </button>
                    </div>
                </div>
            `
        }],
        primary_action_label: null,
        secondary_action_label: null
    });

    current_payment_dialog.show();

    // Setup button event listeners
    setup_payment_dialog_listeners(frm, phone_number, amount, payment_type);

    // Update status section in main interface
    update_status_section('Initiating payment...', 'info');
    show_status_section();

    // Initiate STK Push
    initiate_stk_push_api(frm, phone_number, amount, payment_type);
}

function setup_payment_dialog_listeners(frm, phone_number, amount, payment_type) {
    if (!current_payment_dialog) return;

    const dialog_wrapper = current_payment_dialog.$wrapper;

    // Retry payment button
    dialog_wrapper.find('.btn-retry-payment').on('click', function() {
        $(this).hide();
        dialog_wrapper.find('.btn-switch-cash').hide();
        dialog_wrapper.find('.payment-loading h4').text('Retrying M-Pesa STK Push...');
        dialog_wrapper.find('.payment-loading img').show();
        update_status_section('Retrying payment...', 'warning');
        initiate_stk_push_api(frm, phone_number, amount, payment_type);
    });

    // Switch to cash button
    dialog_wrapper.find('.btn-switch-cash').on('click', function() {
        switch_to_cash_payment(frm, amount, payment_type);
    });

    // Cancel payment button
    dialog_wrapper.find('.btn-cancel-payment').on('click', function() {
        cancel_payment_process(frm);
    });
}

function initiate_stk_push_api(frm, phone_number, amount, payment_type) {
    frappe.call({
        method: "mpesa.mpesa.api.initiate_stk_push",
        args: {
            phone_number: phone_number,
            amount: amount,
            pos_invoice_name: frm.doc.name
        },
        callback: function(r) {
            if (r.message && r.message.ResponseCode === "0") {
                checkout_request_id = r.message.CheckoutRequestID;
                update_payment_dialog('STK Push sent successfully!', 'success');
                update_status_section('Waiting for customer confirmation...', 'info');
                start_payment_polling(frm, checkout_request_id, payment_type);
            } else {
                const error_msg = r.message && r.message.ResponseDescription
                    ? r.message.ResponseDescription
                    : 'STK Push failed';
                update_payment_dialog(`STK Push failed: ${error_msg}`, 'error');
                update_status_section('Payment failed', 'danger');
                show_retry_options();
            }
        },
        error: function(r) {
            console.error('M-Pesa API Error:', r);
            let error_message = 'Failed to initiate M-Pesa payment';

            if (r.responseJSON && r.responseJSON.exception) {
                if (r.responseJSON.exception.includes('does not exist')) {
                    error_message = 'POS Invoice not properly saved';
                } else {
                    error_message = r.responseJSON.exception.split(':').pop().trim();
                }
            }

            update_payment_dialog(`Error: ${error_message}`, 'error');
            update_status_section('Payment initialization failed', 'danger');
            show_retry_options();
        }
    });
}

function start_payment_polling(frm, checkout_request_id, payment_type) {
    // Clear any existing polling
    if (payment_polling_interval) {
        clearInterval(payment_polling_interval);
    }

    let check_count = 0;
    const max_checks = 24; // 2 minutes at 5-second intervals

    payment_polling_interval = setInterval(() => {
        if (check_count >= max_checks) {
            clearInterval(payment_polling_interval);
            update_payment_dialog('Payment timeout - please check manually', 'warning');
            update_status_section('Payment timeout', 'warning');
            show_retry_options();
            show_status_button();
            return;
        }

        check_payment_status(frm, checkout_request_id, payment_type, check_count);
        check_count++;
    }, 5000);
}

function check_payment_status(frm, checkout_request_id, payment_type, check_count) {
    frappe.call({
        method: "frappe.client.get_value",
        args: {
            doctype: "Mpesa Payment",
            filters: { checkout_request_id: checkout_request_id },
            fieldname: ["status", "receipt_number"]
        },
        callback: function(r) {
            if (r.message && r.message.status === "Completed") {
                clearInterval(payment_polling_interval);
                payment_successful(frm, r.message.receipt_number, payment_type);
            } else if (r.message && r.message.status === "Failed") {
                clearInterval(payment_polling_interval);
                payment_failed(frm, payment_type);
            } else {
                // Still waiting - update UI
                const remaining_time = Math.max(0, 120 - (check_count * 5));
                update_payment_dialog(`Waiting for customer confirmation... (${remaining_time}s remaining)`, 'info');
            }
        },
        error: function(err) {
            console.log('Error checking payment status:', err);
        }
    });
}

function payment_successful(frm, receipt_number, payment_type) {
    update_payment_dialog('✅ Payment successful!', 'success');
    update_status_section('Payment completed successfully', 'success');

    frappe.show_alert({
        message: __('M-Pesa payment successful! Receipt: ') + receipt_number,
        indicator: 'green'
    });

    // Complete the order
    setTimeout(() => {
        complete_order_and_print(frm, receipt_number, payment_type);
    }, 2000);
}

function payment_failed(frm, payment_type) {
    update_payment_dialog('❌ Payment failed', 'error');
    update_status_section('Payment failed', 'danger');
    show_retry_options();

    frappe.show_alert({
        message: __('M-Pesa payment failed. Please try again or use cash.'),
        indicator: 'red'
    });
}

function complete_order_and_print(frm, receipt_number, payment_type) {
    frappe.dom.freeze(__('Completing order...'));

    frm.save("Submit").then(() => {
        frappe.dom.unfreeze();

        // Hide payment dialog
        if (current_payment_dialog) {
            current_payment_dialog.hide();
            current_payment_dialog = null;
        }

        // Hide status section
        hide_status_section();

        // Show completion dialog with print options
        show_completion_dialog(frm, receipt_number, payment_type);

    }).catch(err => {
        frappe.dom.unfreeze();
        frappe.show_alert({
            message: __('Failed to submit invoice: ') + (err.message || 'Unknown error'),
            indicator: 'red'
        });
    });
}

function show_completion_dialog(frm, receipt_number, payment_type) {
    const completion_dialog = new frappe.ui.Dialog({
        title: __('Order Completed Successfully'),
        size: 'small',
        fields: [{
            fieldtype: 'HTML',
            fieldname: 'completion_info',
            options: `
                <div class="text-center">
                    <div style="font-size: 48px; color: #5cb85c; margin-bottom: 20px;">
                        ✅
                    </div>
                    <h4 style="color: #5cb85c;">Order Completed!</h4>
                    <p><strong>Invoice:</strong> ${frm.doc.name}</p>
                    <p><strong>Amount:</strong> KES ${frm.doc.grand_total.toLocaleString()}</p>
                    <p><strong>Payment:</strong> ${payment_type === 'mixed' ? 'Mixed (Cash + M-Pesa)' : 'M-Pesa'}</p>
                    ${receipt_number ? `<p><strong>M-Pesa Receipt:</strong> ${receipt_number}</p>` : ''}
                </div>
            `
        }],
        primary_action_label: __('Print Receipt'),
        primary_action: function() {
            print_receipt(frm);
            completion_dialog.hide();
            create_new_invoice();
        },
        secondary_action_label: __('New Order'),
        secondary_action: function() {
            completion_dialog.hide();
            create_new_invoice();
        }
    });

    completion_dialog.show();

    // Auto-close and create new order after 10 seconds
    setTimeout(() => {
        if (completion_dialog && completion_dialog.display) {
            completion_dialog.hide();
            create_new_invoice();
        }
    }, 10000);
}

function print_receipt(frm) {
    // Print the POS Invoice
    frappe.utils.print(
        frm.doc.doctype,
        frm.doc.name,
        'POS Invoice',
        frm.doc.letter_head
    );
}

function create_new_invoice() {
    frappe.new_doc('POS Invoice', true);
}

function switch_to_cash_payment(frm, amount, payment_type) {
    // Remove M-Pesa payment and add cash
    frm.doc.payments = frm.doc.payments.filter(p => p.mode_of_payment !== "M-Pesa Express");

    if (payment_type === 'mixed') {
        // Find existing cash payment and update it
        const cash_payment = frm.doc.payments.find(p => p.mode_of_payment === "Cash");
        if (cash_payment) {
            cash_payment.amount = frm.doc.grand_total;
            cash_payment.base_amount = frm.doc.grand_total;
        } else {
            frm.add_child('payments', {
                mode_of_payment: "Cash",
                amount: frm.doc.grand_total,
                base_amount: frm.doc.grand_total
            });
        }
    } else {
        frm.add_child('payments', {
            mode_of_payment: "Cash",
            amount: frm.doc.grand_total,
            base_amount: frm.doc.grand_total
        });
    }

    frm.refresh_field("payments");
    frm.save();

    if (current_payment_dialog) {
        current_payment_dialog.hide();
        current_payment_dialog = null;
    }

    hide_status_section();

    frappe.show_alert({
        message: __('Switched to cash payment successfully'),
        indicator: 'green'
    });
}

function cancel_payment_process(frm) {
    // Clear polling
    if (payment_polling_interval) {
        clearInterval(payment_polling_interval);
        payment_polling_interval = null;
    }

    // Hide dialog
    if (current_payment_dialog) {
        current_payment_dialog.hide();
        current_payment_dialog = null;
    }

    // Hide status section
    hide_status_section();

    // Reset checkout request ID
    checkout_request_id = null;

    frappe.show_alert({
        message: __('Payment process canceled'),
        indicator: 'orange'
    });
}

function check_payment_status_manually(frm, checkout_request_id) {
    frappe.call({
        method: "frappe.client.get_value",
        args: {
            doctype: "Mpesa Payment",
            filters: { checkout_request_id: checkout_request_id },
            fieldname: ["status", "receipt_number", "result_desc"]
        },
        callback: function(r) {
            if (r.message) {
                const status = r.message.status;
                const receipt = r.message.receipt_number || 'N/A';
                const desc = r.message.result_desc || 'No description';

                frappe.msgprint({
                    title: __('Payment Status'),
                    message: `
                        <p><strong>Status:</strong> ${status}</p>
                        <p><strong>Receipt Number:</strong> ${receipt}</p>
                        <p><strong>Description:</strong> ${desc}</p>
                    `,
                    indicator: status === 'Completed' ? 'green' : status === 'Failed' ? 'red' : 'orange'
                });

                if (status === 'Completed') {
                    payment_successful(frm, receipt, 'manual_check');
                }
            } else {
                frappe.show_alert({
                    message: __('No payment record found'),
                    indicator: 'orange'
                });
            }
        }
    });
}

// Utility functions for UI updates
function update_payment_dialog(message, type) {
    if (!current_payment_dialog) return;

    const colors = {
        'success': '#5cb85c',
        'error': '#d9534f',
        'warning': '#f0ad4e',
        'info': '#5bc0de'
    };

    const icons = {
        'success': '✅',
        'error': '❌',
        'warning': '⚠️',
        'info': 'ℹ️'
    };

    const dialog_wrapper = current_payment_dialog.$wrapper;
    const loading_div = dialog_wrapper.find('.payment-loading');

    if (type === 'success' || type === 'error') {
        loading_div.find('img').hide();
    }

    loading_div.find('h4').html(`${icons[type] || ''} ${message}`).css('color', colors[type] || '#333');
}

function show_retry_options() {
    if (!current_payment_dialog) return;

    const dialog_wrapper = current_payment_dialog.$wrapper;
    dialog_wrapper.find('.btn-retry-payment').show();
    dialog_wrapper.find('.btn-switch-cash').show();
}

function update_status_section(message, type) {
    const statusSection = document.querySelector('.mpesa-status');
    if (statusSection) {
        const alertDiv = statusSection.querySelector('.alert');
        const statusText = statusSection.querySelector('.status-text');

        alertDiv.className = `alert alert-${type}`;
        statusText.textContent = message;
    }
}

function show_status_section() {
    const statusSection = document.querySelector('.mpesa-status');
    if (statusSection) {
        statusSection.style.display = 'block';
    }
}

function hide_status_section() {
    const statusSection = document.querySelector('.mpesa-status');
    if (statusSection) {
        statusSection.style.display = 'none';
    }
}

function show_status_button() {
    const statusButton = document.querySelector('.btn-mpesa-status');
    if (statusButton) {
        statusButton.style.display = 'inline-block';
    }
}
